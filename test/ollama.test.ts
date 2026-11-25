import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaLlm } from "../src/adapters/ollama";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** Records the Authorization header of every request and answers like Ollama. */
async function startFakeOllama(): Promise<{ baseUrl: string; authHeaders: Array<string | null> }> {
  const authHeaders: Array<string | null> = [];
  const server = createServer((request, response) => {
    authHeaders.push(request.headers.authorization ?? null);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/version") {
      response.end(JSON.stringify({ version: "test" }));
    } else if (request.url === "/api/embed") {
      response.end(JSON.stringify({ embeddings: [[0.1, 0.2]] }));
    } else {
      response.end(JSON.stringify({ message: { content: "ok" } }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, authHeaders };
}

async function exercise(llm: ReturnType<typeof createOllamaLlm>): Promise<void> {
  expect(await llm.healthCheck()).toBe(true);
  await llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] });
  await llm.embed(["text"]);
}

describe("Ollama adapter", () => {
  it("sends the API key as a bearer token on every request when configured", async () => {
    const { baseUrl, authHeaders } = await startFakeOllama();
    await exercise(
      createOllamaLlm({ baseUrl, embeddingModel: "e", contextTokens: 1024, apiKey: "s3cret" }),
    );
    expect(authHeaders).toEqual(["Bearer s3cret", "Bearer s3cret", "Bearer s3cret"]);
  });

  it("sends no Authorization header without an API key", async () => {
    const { baseUrl, authHeaders } = await startFakeOllama();
    await exercise(createOllamaLlm({ baseUrl, embeddingModel: "e", contextTokens: 1024 }));
    expect(authHeaders).toEqual([null, null, null]);
  });
});
