import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepositorySync } from "../src/adapters/github-sync";

const TOKEN = "ghp_secretTokenValue123";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "per-bot-github-sync-"));
  tempDirs.push(dir);
  return dir;
}

describe("git repository sync", () => {
  it("keeps the GitHub token out of errors when git fails", async () => {
    const base = tempDir();
    const sync = createGitRepositorySync({
      cloneRoot: join(base, "clones"),
      githubToken: TOKEN,
      resolveCloneUrl: () => join(base, "missing-origin"),
    });

    const error = await sync.sync("owner/missing").then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect((error as Error).message).toContain("git clone failed");
  });

  it("still clones when a token is configured", async () => {
    const base = tempDir();
    const origin = join(base, "origin");
    execFileSync("git", ["init", "-b", "main", origin]);
    execFileSync("git", ["-C", origin, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", origin, "config", "user.name", "Test"]);
    writeFileSync(join(origin, "README.md"), "# Demo\n");
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", ["-C", origin, "commit", "-m", "initial"]);

    const sync = createGitRepositorySync({
      cloneRoot: join(base, "clones"),
      githubToken: TOKEN,
      resolveCloneUrl: () => origin,
    });

    const result = await sync.sync("owner/demo");
    expect(result.changedFiles.map((file) => file.path)).toEqual(["README.md"]);
  });
});
