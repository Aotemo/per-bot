import type { ChatMessage, ChatRequest, ChatResponse, LlmPort, ToolCall } from "../ports/llm";

type OllamaToolCall = {
  function: {
    name: string;
    arguments?: Record<string, unknown>;
  };
};

type OllamaChatResponse = {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
};

type OllamaEmbedResponse = {
  embeddings?: number[][];
};

export type OllamaLlmOptions = {
  baseUrl: string;
  embeddingModel: string;
  /** Context window in tokens; Ollama's default is too small for history plus search results. */
  contextTokens: number;
  /** Bearer token for an Ollama exposed through an authenticating proxy (e.g. on Kaggle). */
  apiKey?: string;
};

const REQUEST_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Talks to the Owner's Ollama instance; there is deliberately no cloud fallback. */
export function createOllamaLlm(options: OllamaLlmOptions): LlmPort {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = options.apiKey
    ? { authorization: `Bearer ${options.apiKey}` }
    : {};

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Ollama ${path} failed with ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await post<OllamaChatResponse>("/api/chat", {
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        stream: false,
        think: false,
        options: { num_ctx: options.contextTokens },
      });

      const message = response.message;
      const text = message?.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

      return {
        text: text ? text : null,
        toolCalls: (message?.tool_calls ?? []).map(toToolCall),
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      const response = await post<OllamaEmbedResponse>("/api/embed", {
        model: options.embeddingModel,
        input: texts,
      });
      return response.embeddings ?? [];
    },

    async healthCheck(): Promise<boolean> {
      try {
        const response = await fetch(`${baseUrl}/api/version`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

type OllamaOutgoingMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] }
  | { role: "tool"; content: string; tool_name: string };

function toOllamaMessage(message: ChatMessage): OllamaOutgoingMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_name: message.name,
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toToolCall(toolCall: OllamaToolCall, index: number): ToolCall {
  return {
    id: `call_${index}`,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments ?? {},
  };
}
