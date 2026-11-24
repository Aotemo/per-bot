import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractDocumentText, isSupportedFileName } from "../knowledge/documents";
import type {
  RepositorySyncPort,
  RepositorySyncResult,
  SyncedFile,
} from "../ports/repository-sync";

const execFileAsync = promisify(execFile);

export type GitRepositorySyncOptions = {
  cloneRoot: string;
  githubToken?: string;
  resolveCloneUrl?: (repository: string) => string;
};

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function createGitRepositorySync(options: GitRepositorySyncOptions): RepositorySyncPort {
  const resolveUrl =
    options.resolveCloneUrl ?? ((repository: string) => `https://github.com/${repository}.git`);
  // Passed per command so the token is never written into the clone's .git/config.
  const authArgs = options.githubToken
    ? [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
          `x-access-token:${options.githubToken}`,
        ).toString("base64")}`,
      ]
    : [];

  return {
    async sync(repository: string): Promise<RepositorySyncResult> {
      mkdirSync(options.cloneRoot, { recursive: true });
      const safeDirName = repository.replace(/[^a-zA-Z0-9._-]/g, "_");
      const repoDir = join(options.cloneRoot, safeDirName);
      const shaMarkerPath = join(options.cloneRoot, `${safeDirName}.last_sha`);

      if (!existsSync(join(repoDir, ".git"))) {
        await git([...authArgs, "clone", "--quiet", resolveUrl(repository), repoDir]);
      } else {
        await git([...authArgs, "pull", "--ff-only", "--quiet"], repoDir);
      }

      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir)) || "main";
      const headSha = await git(["rev-parse", "HEAD"], repoDir);
      const prevSha = existsSync(shaMarkerPath) ? readFileSync(shaMarkerPath, "utf8").trim() : null;

      const changedPaths = new Set<string>();
      const deletedFiles: string[] = [];

      if (!prevSha) {
        const listed = await git(["ls-files"], repoDir);
        for (const line of listed.split("\n")) {
          const path = line.trim();
          if (path && isSupportedFileName(path)) {
            changedPaths.add(path);
          }
        }
      } else if (prevSha !== headSha) {
        const diff = await git(["diff", "--name-status", prevSha, headSha], repoDir);
        for (const line of diff.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          const parts = line.split("\t");
          const status = parts[0] ?? "";
          if (status.startsWith("R") && parts[1] && parts[2]) {
            deletedFiles.push(parts[1]);
            if (isSupportedFileName(parts[2])) {
              changedPaths.add(parts[2]);
            }
          } else if (status === "D" && parts[1]) {
            deletedFiles.push(parts[1]);
          } else if (parts[1] && isSupportedFileName(parts[1])) {
            changedPaths.add(parts[1]);
          }
        }
      }

      const changedFiles: SyncedFile[] = [];
      for (const relPath of changedPaths) {
        const fullPath = join(repoDir, relPath);
        if (!existsSync(fullPath)) {
          continue;
        }
        const buffer = readFileSync(fullPath);
        changedFiles.push({
          path: relPath,
          content: extractDocumentText(relPath, buffer),
        });
      }

      writeFileSync(shaMarkerPath, headSha, "utf8");

      return { branch, changedFiles, deletedFiles };
    },
  };
}
