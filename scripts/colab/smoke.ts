// Smoke test against a live Ollama through the real adapter.
// Usage: OLLAMA_URL=http://127.0.0.1:11434 npx tsx scripts/colab/smoke.ts
import { createOllamaLlm } from "../../src/adapters/ollama";

const baseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const chatModel = process.env.CHAT_MODEL ?? "qwen3:14b";
const llm = createOllamaLlm({ baseUrl, embeddingModel: "bge-m3", contextTokens: 32768 });

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await run();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
}

console.log("health:", await llm.healthCheck());

const vectors = await timed("embed x3", () => llm.embed(["飞书机器人", "知识库检索", "memory"]));
console.log(
  "embedding dims:",
  vectors.map((vector) => vector.length),
);

const plain = await timed("chat (load + answer)", () =>
  llm.chat({
    model: chatModel,
    messages: [{ role: "user", content: "用一句话介绍你自己。" }],
    tools: [],
  }),
);
console.log("answer:", plain.text);

const tool = await timed("chat with tool", () =>
  llm.chat({
    model: chatModel,
    messages: [{ role: "user", content: "在知识库里搜索部署文档" }],
    tools: [
      {
        name: "search_knowledge_base",
        description: "Search the Owner's Knowledge Base",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  }),
);
console.log("tool calls:", JSON.stringify(tool.toolCalls));

const filler = "这是一段用于测试长上下文的填充文本。".repeat(1000);
const long = await timed("chat ~25k tokens prompt", () =>
  llm.chat({
    model: chatModel,
    messages: [
      {
        role: "user",
        content: `${filler}\n\n密码是 ORCHID-42。\n\n${filler}\n\n上文中的密码是什么？只回答密码。`,
      },
    ],
    tools: [],
  }),
);
console.log("long answer:", long.text);
