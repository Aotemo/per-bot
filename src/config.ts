import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const configFileSchema = z.object({
  owner: z.object({
    openId: z.string().min(1),
  }),
  repositories: z.array(z.string().min(1)).default([]),
  bot: z.object({
    chatModel: z.string().min(1),
    embeddingModel: z.string().min(1),
    contextTokens: z.number().int().positive().default(16384),
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
  OLLAMA_URL: z.string().url(),
  GITHUB_TOKEN: z.string().optional(),
});

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
  chatModel: string;
  embeddingModel: string;
  contextTokens: number;
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
    url: string;
  };
  github: {
    token: string | undefined;
  };
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const configPath = resolve(environment.CONFIG_PATH ?? "config.yaml");
  const file = configFileSchema.parse(parseYaml(readFileSync(configPath, "utf8")));
  const env = environmentSchema.parse(environment);

  return {
    ownerOpenId: file.owner.openId,
    repositories: file.repositories,
    chatModel: file.bot.chatModel,
    embeddingModel: file.bot.embeddingModel,
    contextTokens: file.bot.contextTokens,
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
    },
    github: {
      token: env.GITHUB_TOKEN,
    },
  };
}
