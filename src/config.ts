import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const GITHUB_REPOSITORY =
  /^(?:(?:https?:\/\/)?github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/** A GitHub repository as `owner/repo`; full github.com URLs are normalized to that form. */
const repositorySchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const match = GITHUB_REPOSITORY.exec(value);
    if (!match?.[1]) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid repository "${value}": expected a GitHub owner/repo such as Aotemo/per-bot`,
      });
      return z.NEVER;
    }
    return match[1];
  });

const chatProviderSchema = z.enum(["ollama", "codebuddy-cli"]);

const codebuddyConfigSchema = z.object({
  command: z.string().min(1).default("codebuddy"),
  extraArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(180_000),
});

const configFileSchema = z.object({
  owner: z.object({
    openId: z.string().min(1),
  }),
  repositories: z.array(repositorySchema).default([]),
  bot: z.object({
    chatProvider: chatProviderSchema.default("ollama"),
    chatModel: z.string().min(1),
    embeddingModel: z.string().min(1),
    contextTokens: z.number().int().positive().default(32768),
    codebuddy: codebuddyConfigSchema.default({
      command: "codebuddy",
      extraArgs: [],
      timeoutMs: 180_000,
    }),
  }),
  rateLimit: z
    .object({
      maxRequests: z.number().int().positive().default(10),
      windowSeconds: z.number().int().positive().default(60),
    })
    .default({ maxRequests: 10, windowSeconds: 60 }),
  memory: z
    .object({
      proposalTtlDays: z.number().int().positive().default(7),
      extractionIdleMinutes: z.number().int().positive().default(30),
    })
    .default({ proposalTtlDays: 7, extractionIdleMinutes: 30 }),
  storage: z.object({
    database: z.string().min(1),
  }),
});

const environmentSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_DOMAIN: z.enum(["feishu", "lark"]).default("feishu"),
  FEISHU_BOT_OPEN_ID: z.string().optional(),
  OLLAMA_URL: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .pipe(z.string().url().optional()),
  OLLAMA_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
});

export type ChatProvider = z.infer<typeof chatProviderSchema>;

export type CodeBuddyConfig = {
  command: string;
  extraArgs: string[];
  timeoutMs: number;
};

export type RateLimitConfig = {
  maxRequests: number;
  windowSeconds: number;
};

export type MemoryConfig = {
  proposalTtlDays: number;
  extractionIdleMinutes: number;
};

export type Config = {
  ownerOpenId: string;
  repositories: string[];
  chatProvider: ChatProvider;
  chatModel: string;
  embeddingModel: string;
  contextTokens: number;
  codebuddy: CodeBuddyConfig;
  rateLimit: RateLimitConfig;
  memory: MemoryConfig;
  databasePath: string;
  feishu: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    botOpenId: string | undefined;
  };
  ollama: {
    url: string | undefined;
    apiKey: string | undefined;
  };
  github: {
    token: string | undefined;
  };
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const configPath = resolve(environment.CONFIG_PATH ?? "config.yaml");
  const file = configFileSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
  const env = environmentSchema.parse(environment);

  if (file.bot.chatProvider === "ollama" && !env.OLLAMA_URL) {
    throw new Error('OLLAMA_URL is required when bot.chatProvider is "ollama"');
  }

  return {
    ownerOpenId: file.owner.openId,
    repositories: file.repositories,
    chatProvider: file.bot.chatProvider,
    chatModel: file.bot.chatModel,
    embeddingModel: file.bot.embeddingModel,
    contextTokens: file.bot.contextTokens,
    codebuddy: file.bot.codebuddy,
    rateLimit: file.rateLimit,
    memory: file.memory,
    databasePath: file.storage.database,
    feishu: {
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      domain: env.FEISHU_DOMAIN,
      botOpenId: env.FEISHU_BOT_OPEN_ID,
    },
    ollama: {
      url: env.OLLAMA_URL,
      apiKey: env.OLLAMA_API_KEY || undefined,
    },
    github: {
      token: env.GITHUB_TOKEN,
    },
  };
}
