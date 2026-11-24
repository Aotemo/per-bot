import { extname } from "node:path";
import { inflateSync } from "node:zlib";

const SUPPORTED_EXTENSIONS = new Set([
  // Markdown
  ".md",
  ".mdx",
  ".markdown",
  // Plain text & config
  ".txt",
  ".log",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".html",
  ".css",
  // Code
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".swift",
  ".scala",
  ".vue",
  ".svelte",
  // PDF
  ".pdf",
]);

export type TextChunk = {
  content: string;
  startLine: number;
  endLine: number;
};

export function isSupportedFileName(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function extractDocumentText(fileName: string, buffer: Buffer): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    return extractPdfText(buffer);
  }
  return buffer.toString("utf8");
}

function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  if (!raw.startsWith("%PDF-")) {
    return buffer.toString("utf8");
  }

  const fragments: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null = streamRegex.exec(raw);
  while (match !== null) {
    const streamData = match[1] ?? "";
    let decoded = streamData;
    try {
      decoded = inflateSync(Buffer.from(streamData, "latin1")).toString("latin1");
    } catch {
      // Stream may not be FlateDecode compressed; parse as-is.
    }
    extractTextOperators(decoded, fragments);
    match = streamRegex.exec(raw);
  }

  if (fragments.length === 0) {
    extractTextOperators(raw, fragments);
  }

  return fragments.length > 0 ? fragments.join("\n") : buffer.toString("utf8");
}

function extractTextOperators(source: string, out: string[]): void {
  const tjRegex = /\(([^()]*)\)\s*Tj/g;
  let match: RegExpExecArray | null = tjRegex.exec(source);
  while (match !== null) {
    const value = match[1]?.replace(/\\([()\\])/g, "$1").trim();
    if (value) {
      out.push(value);
    }
    match = tjRegex.exec(source);
  }
}

export function chunkText(text: string, maxLines = 40, overlapLines = 5): TextChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = normalized.split("\n");
  if (lines.length === 0 || normalized.trim().length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  const step = Math.max(1, maxLines - overlapLines);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, end).join("\n").trim();
    if (slice.length > 0) {
      chunks.push({
        content: slice,
        startLine: start + 1,
        endLine: end,
      });
    }
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

export function serializeEmbedding(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}
