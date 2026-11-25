import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function loadWithRepositories(repositories: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "per-bot-config-"));
  tempDirs.push(dir);
  const configPath = join(dir, "config.yaml");
  const list = repositories.map((repository) => `  - "${repository}"`).join("\n");
  writeFileSync(
    configPath,
    [
      "owner:",
      "  openId: ou_owner",
      `repositories:${repositories.length === 0 ? " []" : `\n${list}`}`,
      "bot:",
      "  chatModel: qwen3:14b",
      "  embeddingModel: bge-m3",
      "storage:",
      "  database: ./data/per_bot.db",
      "",
    ].join("\n"),
  );
  return loadConfig({
    CONFIG_PATH: configPath,
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret",
    OLLAMA_URL: "http://127.0.0.1:11434",
  });
}

describe("config repositories", () => {
  it("accepts owner/repo and normalizes GitHub URLs to owner/repo", () => {
    const config = loadWithRepositories([
      "Aotemo/per-bot",
      "https://github.com/Aotemo/per-bot",
      "https://github.com/Aotemo/per_bot.git",
      "github.com/Aotemo/per.bot/",
    ]);
    expect(config.repositories).toEqual([
      "Aotemo/per-bot",
      "Aotemo/per-bot",
      "Aotemo/per_bot",
      "Aotemo/per.bot",
    ]);
  });

  it("rejects entries that are not a GitHub owner/repo", () => {
    for (const invalid of [
      "per-bot",
      "https://gitlab.com/Aotemo/per-bot",
      "https://github.com/Aotemo/per-bot/tree/main",
      "Aotemo/per bot",
    ]) {
      expect(() => loadWithRepositories([invalid]), invalid).toThrow(/owner\/repo/);
    }
  });

  it("allows an empty list", () => {
    expect(loadWithRepositories([]).repositories).toEqual([]);
  });
});

function loadWithBotSection(
  botLines: string[],
  envOverrides: Record<string, string | undefined> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "per-bot-config-"));
  tempDirs.push(dir);
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    [
      "owner:",
      "  openId: ou_owner",
      "repositories: []",
      "bot:",
      ...botLines.map((line) => `  ${line}`),
      "storage:",
      "  database: ./data/per_bot.db",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    CONFIG_PATH: configPath,
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret",
    ...envOverrides,
  };
  return loadConfig(env);
}

describe("config chatProvider", () => {
  it("defaults to ollama and requires OLLAMA_URL", () => {
    expect(() => loadWithBotSection(["chatModel: qwen3:14b", "embeddingModel: bge-m3"])).toThrow(
      /OLLAMA_URL/,
    );
  });

  it("accepts codebuddy-cli without OLLAMA_URL and applies codebuddy defaults", () => {
    const config = loadWithBotSection([
      "chatProvider: codebuddy-cli",
      "chatModel: hy4flash-free",
      "embeddingModel: bge-m3",
    ]);
    expect(config.chatProvider).toBe("codebuddy-cli");
    expect(config.chatModel).toBe("hy4flash-free");
    expect(config.ollama.url).toBeUndefined();
    expect(config.codebuddy).toEqual({
      command: "codebuddy",
      extraArgs: [],
      timeoutMs: 180_000,
    });
  });

  it("parses custom codebuddy CLI options alongside optional OLLAMA_URL", () => {
    const config = loadWithBotSection(
      [
        "chatProvider: codebuddy-cli",
        "chatModel: deepseek-v4.1-flash",
        "embeddingModel: bge-m3",
        "codebuddy:",
        "  command: /usr/local/bin/codebuddy",
        "  extraArgs:",
        '    - "--effort"',
        '    - "low"',
        "  timeoutMs: 60000",
      ],
      { OLLAMA_URL: "http://127.0.0.1:11434" },
    );
    expect(config.ollama.url).toBe("http://127.0.0.1:11434");
    expect(config.codebuddy).toEqual({
      command: "/usr/local/bin/codebuddy",
      extraArgs: ["--effort", "low"],
      timeoutMs: 60_000,
    });
  });
});
