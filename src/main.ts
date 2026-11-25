import "dotenv/config";
import { dirname, join } from "node:path";
import { createCodeBuddyCliLlm } from "./adapters/codebuddy-cli";
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
import type { LlmPort } from "./ports/llm";
import { openStorage } from "./storage/database";

const MAX_SEEN_EVENT_IDS = 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = openStorage(config.databasePath);

  const ollamaLlm = config.ollama.url
    ? createOllamaLlm({
        baseUrl: config.ollama.url,
        embeddingModel: config.embeddingModel,
        contextTokens: config.contextTokens,
        ...(config.ollama.apiKey ? { apiKey: config.ollama.apiKey } : {}),
      })
    : undefined;

  let llm: LlmPort;
  if (config.chatProvider === "codebuddy-cli") {
    llm = createCodeBuddyCliLlm({
      ...config.codebuddy,
      ...(ollamaLlm ? { embedProvider: ollamaLlm } : {}),
    });
  } else {
    if (!ollamaLlm) {
      throw new Error('OLLAMA_URL is required when bot.chatProvider is "ollama"');
    }
    llm = ollamaLlm;
  }

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

  // Feishu redelivers an event that is not acknowledged within 3 seconds, and the SDK only
  // acknowledges once the handler returns. Handlers therefore return immediately and the bot
  // works in the background; event ids catch any redelivery that still happens.
  const seenEventIds = new Set<string>();
  const isRedelivery = (eventId: string | undefined): boolean => {
    if (!eventId) {
      return false;
    }
    if (seenEventIds.has(eventId)) {
      return true;
    }
    seenEventIds.add(eventId);
    if (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      const oldest = seenEventIds.values().next().value;
      if (oldest !== undefined) {
        seenEventIds.delete(oldest);
      }
    }
    return false;
  };

  feishu.dispatcher.register({
    "im.message.receive_v1": (event) => {
      if (isRedelivery(event.event_id)) {
        return;
      }
      const message = normalizeMessageEvent(event, config.feishu.botOpenId);
      if (!message) {
        return;
      }
      bot.handle(message).catch((error) => {
        console.error("failed to handle message", error);
      });
    },
    "card.action.trigger": (event: RawCardActionEvent & { event_id?: string }) => {
      if (isRedelivery(event.event_id)) {
        return;
      }
      const action = normalizeCardActionEvent(event);
      if (!action) {
        return;
      }
      bot.handle(action).catch((error) => {
        console.error("failed to handle card action", error);
      });
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
