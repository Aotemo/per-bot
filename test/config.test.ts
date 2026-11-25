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
