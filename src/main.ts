import "dotenv/config";
import { dirname, join } from "node:path";
import {
  createFeishuAdapter,
  normalizeCardActionEvent,
  normalizeMessageEvent,
  type RawCardActionEvent,
} from "./adapters/feishu";
import { createGitRepositorySync } from "./adapters/github-sync";
import { createOllamaLlm } from "./adapters/ollama";
import { createBot } from "./bot/core";
import { loadConfig } from "./config";
import { openStorage } from "./storage/database";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = openStorage(config.databasePath);

  const llm = createOllamaLlm({
    baseUrl: config.ollama.url,
    embeddingModel: config.embeddingModel,
    contextTokens: config.contextTokens,
  });

  const feishu = createFeishuAdapter(config.feishu);
  const repositorySync = createGitRepositorySync({
    cloneRoot: join(dirname(config.databasePath), "repos"),
    ...(config.github.token ? { githubToken: config.github.token } : {}),
  });

  const bot = createBot({
    settings: {
      ownerOpenId: config.ownerOpenId,
      repositories: config.repositories,
      chatModel: config.chatModel,
      rateLimit: config.rateLimit,
      memory: config.memory,
    },
    storage,
    feishu: feishu.port,
    llm,
    repositorySync,
    clock: {
      now: () => new Date(),
    },
  });

  feishu.dispatcher.register({
    "im.message.receive_v1": async (event) => {
      const message = normalizeMessageEvent(event, config.feishu.botOpenId);
      if (!message) {
        return;
      }
      try {
        await bot.handle(message);
      } catch (error) {
        console.error("failed to handle message", error);
      }
    },
    "card.action.trigger": async (event: RawCardActionEvent) => {
      const action = normalizeCardActionEvent(event);
      if (!action) {
        return;
      }
      try {
        await bot.handle(action);
      } catch (error) {
        console.error("failed to handle card action", error);
      }
    },
  });

  await feishu.wsClient.start({ eventDispatcher: feishu.dispatcher });
  console.info("per_bot connected to Feishu");

  bot.tick().catch((error) => {
    console.error("initial tick failed", error);
  });

  const tickInterval = setInterval(() => {
    bot.tick().catch((error) => {
      console.error("background tick failed", error);
    });
  }, 30_000);

  const shutdown = () => {
    clearInterval(tickInterval);
    feishu.wsClient.close({ force: true });
    storage.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("per_bot failed to start", error);
  process.exit(1);
});
