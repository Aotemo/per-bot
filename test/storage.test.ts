import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage } from "../src/storage/database";

let directory: string | undefined;

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("storage", () => {
  it("creates the database file with sqlite-vec loaded", () => {
    directory = mkdtempSync(join(tmpdir(), "per-bot-"));
    const storage = openStorage(join(directory, "nested", "per_bot.db"));

    const version = storage.db.prepare("SELECT vec_version() AS version").get() as {
      version: string;
    };
    expect(version.version).toMatch(/^v?\d+\.\d+\.\d+/);

    storage.close();
  });
});
