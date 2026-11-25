import { describe, expect, it } from "vitest";
import { type CliCommandRunner, createCodeBuddyCliLlm } from "../src/adapters/codebuddy-cli";
import type { ToolDefinition } from "../src/ports/llm";

const SEARCH_TOOL: ToolDefinition = {
  name: "search_knowledge_base",
  description: "Search the Knowledge Base.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("CodeBuddy CLI adapter", () => {
  it("invokes codebuddy in headless JSON print mode and parses the final result event", async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const runCommand: CliCommandRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return {
        stdout: JSON.stringify([
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello!" }],
          },
          { type: "result", subtype: "success", is_error: false, result: "Hello!" },
        ]),
        stderr: "",
      };
    };

    const llm = createCodeBuddyCliLlm({
      command: "codebuddy",
      extraArgs: ["--effort", "low"],
      runCommand,
    });

    const response = await llm.chat({
      model: "hy4flash-free",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say hi" },
      ],
      tools: [],
    });

    expect(response).toEqual({ text: "Hello!", toolCalls: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("codebuddy");
    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--max-turns",
      "1",
      "--model",
      "hy4flash-free",
      "--system-prompt",
      "Be concise.",
      "--effort",
      "low",
    ]);
    expect(calls[0]?.input).toBe("[User]\nSay hi");
  });

  it("parses JSON tool calls when tools are provided and ignores unknown tools", async () => {
    const runCommand: CliCommandRunner = async () => ({
      stdout: JSON.stringify([
        {
          type: "result",
          is_error: false,
          result:
            '```json\n{"tool_calls":[{"name":"search_knowledge_base","arguments":{"query":"config"}},{"name":"unknown_tool","arguments":{}}]}\n```',
        },
      ]),
      stderr: "",
    });

    const llm = createCodeBuddyCliLlm({ runCommand });
    const response = await llm.chat({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "Where is config?" }],
      tools: [SEARCH_TOOL],
    });

    expect(response).toEqual({
      text: null,
      toolCalls: [
        {
          id: "call_0",
          name: "search_knowledge_base",
          arguments: { query: "config" },
        },
      ],
    });
  });

  it("parses DeepSeek DSML tool calls and strips residual DSML tags when tools are disabled", async () => {
    const dsmlOutput = [
      "<｜DSML｜ calls>",
      '<｜DSML｜ invoke name="search_knowledge_base">',
      '<｜DSML｜ parameter name="query" string="true">项目整体架构 模块划分</｜DSML｜ parameter>',
      "</｜DSML｜ invoke>",
      "</｜DSML｜ calls>",
    ].join("\n");

    const runCommand: CliCommandRunner = async () => ({
      stdout: JSON.stringify([{ type: "result", is_error: false, result: dsmlOutput }]),
      stderr: "",
    });

    const llm = createCodeBuddyCliLlm({ runCommand });
    const withTools = await llm.chat({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "整体架构是什么？" }],
      tools: [SEARCH_TOOL],
    });
    expect(withTools).toEqual({
      text: null,
      toolCalls: [
        {
          id: "call_0",
          name: "search_knowledge_base",
          arguments: { query: "项目整体架构 模块划分" },
        },
      ],
    });

    const withoutTools = await llm.chat({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "整体架构是什么？" }],
      tools: [],
    });
    expect(withoutTools).toEqual({ text: null, toolCalls: [] });
  });

  it("throws when codebuddy returns an error result event", async () => {
    const runCommand: CliCommandRunner = async () => ({
      stdout: JSON.stringify([{ type: "result", is_error: true, result: "quota exceeded" }]),
      stderr: "",
    });

    const llm = createCodeBuddyCliLlm({ runCommand });
    await expect(
      llm.chat({
        model: "hy4std",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    ).rejects.toThrow(/quota exceeded/);
  });

  it("delegates embed and embedHealthCheck to embedProvider when configured", async () => {
    const runCommand: CliCommandRunner = async () => ({ stdout: "1.0.0", stderr: "" });
    const llm = createCodeBuddyCliLlm({
      runCommand,
      embedProvider: {
        async embed(texts) {
          return texts.map(() => [0.5, 0.25]);
        },
        async healthCheck() {
          return true;
        },
      },
    });

    expect(await llm.healthCheck()).toBe(true);
    expect(await llm.embedHealthCheck?.()).toBe(true);
    expect(await llm.embed(["a"])).toEqual([[0.5, 0.25]]);
  });

  it("reports embedHealthCheck false and rejects embed when no embedProvider is configured", async () => {
    const runCommand: CliCommandRunner = async () => ({ stdout: "1.0.0", stderr: "" });
    const llm = createCodeBuddyCliLlm({ runCommand });

    expect(await llm.healthCheck()).toBe(true);
    expect(await llm.embedHealthCheck?.()).toBe(false);
    await expect(llm.embed(["a"])).rejects.toThrow(/OLLAMA_URL/);
  });
});
