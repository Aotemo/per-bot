import { spawn } from "node:child_process";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmPort,
  ToolCall,
  ToolDefinition,
} from "../ports/llm";

export type CliCommandResult = {
  stdout: string;
  stderr: string;
};

export type CliCommandRunner = (
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
) => Promise<CliCommandResult>;

export type CodeBuddyCliLlmOptions = {
  /** Executable name or path for CodeBuddy CLI. */
  command?: string;
  /** Additional CLI flags appended to each invocation. */
  extraArgs?: string[];
  /** Timeout per chat call in milliseconds. */
  timeoutMs?: number;
  /** Optional provider (e.g. Ollama) used for embeddings and Knowledge Base indexing. */
  embedProvider?: Pick<LlmPort, "embed" | "healthCheck">;
  /** Optional command runner override for testing. */
  runCommand?: CliCommandRunner;
};

const DEFAULT_COMMAND = "codebuddy";
const DEFAULT_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function defaultRunCommand(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<CliCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(input, "utf8");
  });
}

function buildSystemPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.content.trim()) {
      sections.push(message.content.trim());
    }
  }
  if (tools.length > 0) {
    const toolSpecs = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    sections.push(
      [
        "Available tools:",
        JSON.stringify(toolSpecs),
        'To call one or more tools, respond with ONLY a JSON object of the form {"tool_calls":[{"name":"<tool_name>","arguments":{...}}]} and no other text.',
        "When you do not need to call a tool, respond directly to the user in plain text (do not wrap your answer in JSON).",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function formatTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "user") {
      parts.push(`[User]\n${message.content}`);
    } else if (message.role === "assistant") {
      if (message.content.trim()) {
        parts.push(`[Assistant]\n${message.content}`);
      }
      if (message.toolCalls && message.toolCalls.length > 0) {
        const serialized = JSON.stringify(
          message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
        );
        parts.push(`[Assistant Tool Calls]\n${serialized}`);
      }
    } else if (message.role === "tool") {
      parts.push(`[Tool Result: ${message.name}]\n${message.content}`);
    }
  }
  return parts.join("\n\n");
}

type CodeBuddyResultEvent = {
  type?: unknown;
  is_error?: unknown;
  result?: unknown;
  role?: unknown;
  content?: unknown;
};

function extractResultText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  const events: CodeBuddyResultEvent[] = Array.isArray(parsed)
    ? parsed.filter(
        (item): item is CodeBuddyResultEvent => typeof item === "object" && item !== null,
      )
    : typeof parsed === "object" && parsed !== null
      ? [parsed as CodeBuddyResultEvent]
      : [];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "result") {
      const text = typeof event.result === "string" ? event.result : "";
      if (event.is_error === true) {
        throw new Error(`codebuddy-cli returned an error: ${text || "unknown error"}`);
      }
      return text;
    }
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "message" && event.role === "assistant" && Array.isArray(event.content)) {
      const texts: string[] = [];
      for (const block of event.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) {
        return texts.join("\n");
      }
    }
  }

  return "";
}

const DSML_INVOKE_REGEX =
  /<[|｜]DSML[|｜]\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[|｜]DSML[|｜]\s*invoke\s*>/g;
const DSML_PARAM_REGEX =
  /<[|｜]DSML[|｜]\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[|｜]DSML[|｜]\s*parameter\s*>/g;
const DSML_BLOCK_REGEX =
  /<[|｜]DSML[|｜]\s*(?:function_)?calls\s*>[\s\S]*?<\/[|｜]DSML[|｜]\s*(?:function_)?calls\s*>/g;

function parseDsmlToolCalls(text: string, allowedNames: Set<string>): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  DSML_INVOKE_REGEX.lastIndex = 0;
  let invokeMatch = DSML_INVOKE_REGEX.exec(text);
  while (invokeMatch !== null) {
    const name = invokeMatch[1]?.trim();
    const body = invokeMatch[2] ?? "";
    if (name && allowedNames.has(name)) {
      const args: Record<string, unknown> = {};
      DSML_PARAM_REGEX.lastIndex = 0;
      let paramMatch = DSML_PARAM_REGEX.exec(body);
      while (paramMatch !== null) {
        const paramName = paramMatch[1]?.trim();
        const isString = paramMatch[2] !== "false";
        const rawValue = (paramMatch[3] ?? "").trim();
        if (paramName) {
          if (isString) {
            args[paramName] = rawValue;
          } else {
            try {
              args[paramName] = JSON.parse(rawValue);
            } catch {
              args[paramName] = rawValue;
            }
          }
        }
        paramMatch = DSML_PARAM_REGEX.exec(body);
      }
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name,
        arguments: args,
      });
    }
    invokeMatch = DSML_INVOKE_REGEX.exec(text);
  }
  return toolCalls;
}

function parseChatResponse(rawText: string, tools: ToolDefinition[]): ChatResponse {
  const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!cleaned) {
    return { text: null, toolCalls: [] };
  }

  if (tools.length > 0) {
    const allowedNames = new Set(tools.map((tool) => tool.name));
    const dsmlCalls = parseDsmlToolCalls(cleaned, allowedNames);
    if (dsmlCalls.length > 0) {
      return { text: null, toolCalls: dsmlCalls };
    }

    const unfenced = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    if (unfenced.startsWith("{") && unfenced.endsWith("}")) {
      try {
        const parsed = JSON.parse(unfenced) as { tool_calls?: unknown };
        if (Array.isArray(parsed.tool_calls)) {
          const toolCalls: ToolCall[] = [];
          for (const rawCall of parsed.tool_calls) {
            if (typeof rawCall !== "object" || rawCall === null) {
              continue;
            }
            const record = rawCall as { name?: unknown; arguments?: unknown };
            if (typeof record.name !== "string" || !allowedNames.has(record.name)) {
              continue;
            }
            const args =
              typeof record.arguments === "object" &&
              record.arguments !== null &&
              !Array.isArray(record.arguments)
                ? (record.arguments as Record<string, unknown>)
                : {};
            toolCalls.push({
              id: `call_${toolCalls.length}`,
              name: record.name,
              arguments: args,
            });
          }
          if (toolCalls.length > 0) {
            return { text: null, toolCalls };
          }
        }
      } catch {
        // Not valid JSON; treat as a plain text answer.
      }
    }
  }

  const sanitized = cleaned.replace(DSML_BLOCK_REGEX, "").trim();
  return { text: sanitized || null, toolCalls: [] };
}

/** Talks to third-party models exposed through the local `codebuddy` CLI in headless print mode. */
export function createCodeBuddyCliLlm(options: CodeBuddyCliLlmOptions = {}): LlmPort {
  const command = options.command ?? DEFAULT_COMMAND;
  const extraArgs = options.extraArgs ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCommand = options.runCommand ?? defaultRunCommand;

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const systemPrompt = buildSystemPrompt(request.messages, request.tools);
      const transcript = formatTranscript(request.messages);
      const args = [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--model",
        request.model,
        ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
        ...extraArgs,
      ];

      const { stdout } = await runCommand(command, args, transcript, timeoutMs);
      const resultText = extractResultText(stdout);
      return parseChatResponse(resultText, request.tools);
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (!options.embedProvider) {
        throw new Error(
          "Embeddings are not configured: set OLLAMA_URL to enable Knowledge Base indexing and search",
        );
      }
      return options.embedProvider.embed(texts);
    },

    async healthCheck(): Promise<boolean> {
      try {
        await runCommand(command, ["--version"], "", HEALTH_CHECK_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    },

    async embedHealthCheck(): Promise<boolean> {
      if (!options.embedProvider) {
        return false;
      }
      return options.embedProvider.healthCheck();
    },
  };
}
