import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepositorySync } from "../src/adapters/github-sync";
import { type BotSettings, createBot } from "../src/bot/core";
import type { InboundFile, InboundMessage } from "../src/domain/inbound";
import type { GroupMember } from "../src/ports/feishu";
import type { RepositorySyncPort } from "../src/ports/repository-sync";
import { openStorage, type Storage } from "../src/storage/database";
import {
  createFakeFeishu,
  createFakeLlm,
  createFakeRepositorySync,
  createManualClock,
  type ScriptedReply,
} from "./fakes";

const OWNER_OPEN_ID = "ou_owner";
const ALLOWED_GROUP_ID = "oc_allowed_group";
const OTHER_GROUP_ID = "oc_other_group";
const MEMBER_OPEN_ID = "ou_member";
const OUTSIDER_OPEN_ID = "ou_outsider";

const tempDirs: string[] = [];
const openStorages: Storage[] = [];

afterEach(() => {
  while (openStorages.length > 0) {
    openStorages.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempStorage(): Storage {
  const dir = mkdtempSync(join(tmpdir(), "per-bot-test-"));
  tempDirs.push(dir);
  const storage = openStorage(join(dir, "per_bot.db"));
  openStorages.push(storage);
  return storage;
}

function defaultSettings(overrides: Partial<BotSettings> = {}): BotSettings {
  return {
    ownerOpenId: OWNER_OPEN_ID,
    chatModel: "qwen3:14b",
    allowedGroups: [ALLOWED_GROUP_ID],
    ...overrides,
  };
}

function privateMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    chatType: "private",
    chatId: "oc_private",
    topicId: null,
    messageId: "om_1",
    sender: { openId: OWNER_OPEN_ID, name: "Owner" },
    mentionsBot: false,
    text: "帮我看下 per_bot 是不是已经跑起来了",
    ...overrides,
  };
}

function groupMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    chatType: "group",
    chatId: ALLOWED_GROUP_ID,
    topicId: "om_root_1",
    messageId: "om_2",
    sender: { openId: MEMBER_OPEN_ID, name: "Member" },
    mentionsBot: true,
    text: "请问这个项目怎么启动？",
    ...overrides,
  };
}

function buildBot(
  script: ScriptedReply[],
  options: {
    groups?: Record<string, Array<string | GroupMember>>;
    settings?: Partial<BotSettings>;
    startTime?: Date;
    repositorySync?: RepositorySyncPort;
  } = {},
) {
  const storage = createTempStorage();
  const feishu = createFakeFeishu(
    options.groups ?? { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID] },
  );
  const llm = createFakeLlm(script);
  const clock = createManualClock(options.startTime ?? new Date("2026-01-01T00:00:00Z"));
  const repositorySync = options.repositorySync ?? createFakeRepositorySync();
  const bot = createBot({
    settings: defaultSettings(options.settings),
    storage,
    feishu,
    llm,
    repositorySync,
    clock,
  });
  return { bot, feishu, llm, clock, storage, repositorySync };
}

describe("bot core — tracer bullet (#2)", () => {
  it("answers an Owner's private message with the model's reply", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "已经跑起来了。" }]);

    await bot.handle(privateMessage());

    expect(feishu.replies).toEqual([
      { chatId: "oc_private", topicId: "om_1", text: "已经跑起来了。" },
    ]);
    expect(llm.requests).toHaveLength(1);
    const request = llm.requests[0];
    expect(request?.messages.at(-1)?.role).toBe("user");
    expect(request?.messages.at(-1)?.content).toContain("帮我看下 per_bot 是不是已经跑起来了");
    const system = request?.messages.find((message) => message.role === "system");
    expect(system?.content).toContain("assistant");
    expect(system?.content).toContain("Owner");
  });

  it("replies in the topic the Owner asked in", async () => {
    const { bot, feishu } = buildBot([{ text: "在话题里回答。" }]);

    await bot.handle(privateMessage({ topicId: "om_topic_root" }));

    expect(feishu.replies).toEqual([
      { chatId: "oc_private", topicId: "om_topic_root", text: "在话题里回答。" },
    ]);
  });
});

describe("bot core — authorization and @-only triggering (#3)", () => {
  it("replies when an Allowed Group member @-mentions the bot in that group", async () => {
    const { bot, feishu } = buildBot([{ text: "运行 npm start 即可。" }]);

    await bot.handle(groupMessage());

    expect(feishu.replies).toEqual([
      { chatId: ALLOWED_GROUP_ID, topicId: "om_root_1", text: "运行 npm start 即可。" },
    ]);
  });

  it("stays silent for group messages that do not @-mention the bot", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "不该出现" }]);

    await bot.handle(groupMessage({ mentionsBot: false }));

    expect(feishu.replies).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("allows a member of an Allowed Group to privately chat with the bot", async () => {
    const { bot, feishu } = buildBot([{ text: "私聊回复。" }]);

    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
      }),
    );

    expect(feishu.replies).toEqual([
      { chatId: "oc_member_private", topicId: "om_1", text: "私聊回复。" },
    ]);
  });

  it("replies with no permission when a non-User privately messages the bot", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "不该调用模型" }]);

    await bot.handle(
      privateMessage({
        chatId: "oc_outsider_private",
        sender: { openId: OUTSIDER_OPEN_ID, name: "Outsider" },
      }),
    );

    expect(feishu.replies).toHaveLength(1);
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("permission");
    expect(llm.requests).toHaveLength(0);
  });

  it("replies with no permission when a non-User @-mentions the bot in a group", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "不该调用模型" }]);

    await bot.handle(
      groupMessage({
        sender: { openId: OUTSIDER_OPEN_ID, name: "Outsider" },
        mentionsBot: true,
      }),
    );

    expect(feishu.replies).toHaveLength(1);
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("permission");
    expect(llm.requests).toHaveLength(0);
  });

  it("does not answer messages in groups that are not Allowed Groups", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "不该回答" }]);

    await bot.handle(
      groupMessage({
        chatId: OTHER_GROUP_ID,
        sender: { openId: OWNER_OPEN_ID, name: "Owner" },
        mentionsBot: true,
      }),
    );

    expect(feishu.replies).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("caches group membership lookups via FeishuPort", async () => {
    const { bot, feishu } = buildBot([{ text: "一" }, { text: "二" }]);

    await bot.handle(groupMessage({ messageId: "om_1" }));
    await bot.handle(groupMessage({ messageId: "om_2" }));

    expect(feishu.groupMemberLookups).toEqual([ALLOWED_GROUP_ID]);
  });
});

describe("bot core — per-topic conversations (#4)", () => {
  it("passes earlier messages of the same topic as context on follow-up", async () => {
    const { bot, llm } = buildBot([
      { text: "它在端口 3000 运行。" },
      { text: "可以用 PORT 修改。" },
    ]);

    await bot.handle(
      privateMessage({ messageId: "om_root", topicId: null, text: "服务跑在哪个端口？" }),
    );
    await bot.handle(
      privateMessage({ messageId: "om_reply_1", topicId: "om_root", text: "怎么改端口？" }),
    );

    expect(llm.requests).toHaveLength(2);
    const secondMessages = llm.requests[1]?.messages ?? [];
    expect(secondMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(secondMessages[1]?.content).toContain("服务跑在哪个端口？");
    expect(secondMessages[2]?.content).toBe("它在端口 3000 运行。");
    expect(secondMessages[3]?.content).toContain("怎么改端口？");
  });

  it("isolates context between different topics", async () => {
    const { bot, llm } = buildBot([{ text: "话题 A 回复" }, { text: "话题 B 回复" }]);

    await bot.handle(privateMessage({ messageId: "om_a", topicId: null, text: "关于话题 A" }));
    await bot.handle(privateMessage({ messageId: "om_b", topicId: null, text: "关于话题 B" }));

    const secondMessages = llm.requests[1]?.messages ?? [];
    expect(secondMessages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(secondMessages[1]?.content).not.toContain("话题 A");
  });

  it("identifies who said each message in a multi-person group topic", async () => {
    const bobId = "ou_bob";
    const { bot, llm } = buildBot(
      [{ text: "好的，记下了。" }, { text: "Bob 负责后端，Member 负责前端。" }],
      {
        groups: { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID, bobId] },
      },
    );

    await bot.handle(
      groupMessage({
        topicId: "om_multi",
        messageId: "om_m1",
        sender: { openId: bobId, name: "Bob" },
        mentionsBot: true,
        text: "我负责后端",
      }),
    );
    await bot.handle(
      groupMessage({
        topicId: "om_multi",
        messageId: "om_m2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        mentionsBot: true,
        text: "我负责前端，谁负责后端？",
      }),
    );

    expect(llm.requests).toHaveLength(2);
    const messages = llm.requests[1]?.messages ?? [];
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.content).toContain("Bob");
    expect(userMessages[0]?.content).toContain("我负责后端");
    expect(userMessages[1]?.content).toContain("Member");
    expect(userMessages[1]?.content).toContain("我负责前端");
  });

  it("does not record group messages that do not @-mention the bot", async () => {
    const bobId = "ou_bob";
    const { bot, llm } = buildBot([{ text: "回复" }], {
      groups: { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID, bobId] },
    });

    await bot.handle(
      groupMessage({
        topicId: "om_silent",
        messageId: "om_s1",
        sender: { openId: bobId, name: "Bob" },
        mentionsBot: false,
        text: "这句没有 @ bot",
      }),
    );
    await bot.handle(
      groupMessage({ topicId: "om_silent", messageId: "om_s2", text: "这句 @ 了 bot" }),
    );

    const userMessages = (llm.requests[0]?.messages ?? []).filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).not.toContain("这句没有 @ bot");
  });

  it("resolves sender display names from group membership", async () => {
    const { bot, llm } = buildBot([{ text: "回复" }], {
      groups: {
        [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, { openId: MEMBER_OPEN_ID, name: "Alice" }],
      },
    });

    await bot.handle(
      groupMessage({ sender: { openId: MEMBER_OPEN_ID, name: null }, text: "我是谁？" }),
    );

    const userMessage = llm.requests[0]?.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("Alice");
  });

  it("persists conversations in SQLite across bot restarts", async () => {
    const { bot, storage, feishu, clock, repositorySync } = buildBot([{ text: "第一轮回复" }]);

    await bot.handle(
      privateMessage({ messageId: "om_persist", topicId: null, text: "记住这轮上下文" }),
    );

    const nextLlm = createFakeLlm([{ text: "第二轮回复" }]);
    const restartedBot = createBot({
      settings: defaultSettings(),
      storage,
      feishu,
      llm: nextLlm,
      repositorySync,
      clock,
    });

    await restartedBot.handle(
      privateMessage({ messageId: "om_persist_2", topicId: "om_persist", text: "上一轮说了啥？" }),
    );

    const messages = nextLlm.requests[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]?.content).toContain("记住这轮上下文");
    expect(messages[2]?.content).toBe("第一轮回复");
  });
});

describe("bot core — model availability and rate limiting (#5)", () => {
  it("immediately replies model offline when LLM health check fails", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "不该出现" }]);
    llm.setOffline(true);

    await bot.handle(privateMessage());

    expect(feishu.replies).toHaveLength(1);
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("offline");
    expect(llm.requests).toHaveLength(0);
  });

  it("processes LLM requests one at a time in FIFO order and sends thinking ack when queued", async () => {
    const { bot, feishu, llm } = buildBot([
      { text: "回复 1" },
      { text: "回复 2" },
      { text: "回复 3" },
    ]);
    const releaseFirst = llm.pauseNextChat();

    const p1 = bot.handle(privateMessage({ messageId: "om_1", text: "问题 1" }));
    await Promise.resolve();
    await Promise.resolve();

    const p2 = bot.handle(privateMessage({ messageId: "om_2", text: "问题 2" }));
    const p3 = bot.handle(privateMessage({ messageId: "om_3", text: "问题 3" }));
    await Promise.resolve();
    await Promise.resolve();

    // Queued requests receive immediate "thinking" acknowledgements before first finishes
    expect(
      feishu.replies.filter((r) => r.text.toLowerCase().includes("thinking")).map((r) => r.topicId),
    ).toEqual(["om_2", "om_3"]);
    expect(llm.maxInFlight).toBe(1);

    releaseFirst();
    await Promise.all([p1, p2, p3]);

    expect(llm.maxInFlight).toBe(1);
    expect(
      feishu.replies.filter((r) => !r.text.toLowerCase().includes("thinking")).map((r) => r.text),
    ).toEqual(["回复 1", "回复 2", "回复 3"]);
  });

  it("rate-limits non-Owner Users within the configured window and resets after window passes", async () => {
    const { bot, feishu, llm, clock } = buildBot(
      [{ text: "答 1" }, { text: "答 2" }, { text: "答 3" }],
      { settings: { rateLimit: { maxRequests: 2, windowSeconds: 60 } } },
    );

    const memberPrivate = (id: string) =>
      privateMessage({
        chatId: "oc_member_private",
        messageId: id,
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
      });

    await bot.handle(memberPrivate("om_1"));
    await bot.handle(memberPrivate("om_2"));
    await bot.handle(memberPrivate("om_3"));

    expect(llm.requests).toHaveLength(2);
    expect(feishu.replies[2]?.text.toLowerCase()).toContain("rate limit");

    clock.advance(61_000);
    await bot.handle(memberPrivate("om_4"));
    expect(llm.requests).toHaveLength(3);
    expect(feishu.replies[3]?.text).toBe("答 3");
  });

  it("never rate-limits the Owner", async () => {
    const { bot, feishu, llm } = buildBot([{ text: "答 1" }, { text: "答 2" }, { text: "答 3" }], {
      settings: { rateLimit: { maxRequests: 1, windowSeconds: 60 } },
    });

    await bot.handle(privateMessage({ messageId: "om_1" }));
    await bot.handle(privateMessage({ messageId: "om_2" }));
    await bot.handle(privateMessage({ messageId: "om_3" }));

    expect(llm.requests).toHaveLength(3);
    expect(feishu.replies.map((r) => r.text)).toEqual(["答 1", "答 2", "答 3"]);
  });

  it("forces a plain answer when the model exhausts its tool rounds", async () => {
    const search = (id: string): ScriptedReply => ({
      toolCall: { id, name: "search_knowledge_base", arguments: { query: "loop" } },
    });
    const { bot, feishu, llm } = buildBot([
      search("c1"),
      search("c2"),
      search("c3"),
      search("c4"),
      search("c5"),
      { text: "根据已有信息的回答。" },
    ]);

    await bot.handle(privateMessage());

    expect(llm.requests.at(-1)?.tools).toEqual([]);
    expect(feishu.replies.at(-1)?.text).toBe("根据已有信息的回答。");
  });
});

function fileEvent(overrides: Partial<InboundFile> = {}): InboundFile {
  return {
    kind: "file",
    chatType: "private",
    chatId: "oc_private",
    topicId: null,
    messageId: "om_file_1",
    sender: { openId: OWNER_OPEN_ID, name: "Owner" },
    fileKey: "file_key_1",
    fileName: "deploy.md",
    ...overrides,
  };
}

describe("bot core — Owner Documents and Knowledge Base retrieval (#6)", () => {
  it("ingests supported Owner Documents, indexes them, and cites filename when searched", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_1",
          name: "search_knowledge_base",
          arguments: { query: "deploy port" },
        },
      },
      { text: "部署端口是 8080。" },
    ]);
    feishu.files.set("file_key_1", Buffer.from("# Deploy\nThe service listens on port 8080.\n"));

    await bot.handle(fileEvent());
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("pending indexing");

    await bot.tick();
    expect(llm.embedCalls.length).toBeGreaterThan(0);

    await bot.handle(privateMessage({ messageId: "om_q1", text: "部署端口是多少？" }));

    expect(llm.requests).toHaveLength(2);
    const toolMessage = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("8080");
    expect(toolMessage?.content).toContain("deploy.md");

    const answer = feishu.replies.at(-1)?.text ?? "";
    expect(answer).toContain("8080");
    expect(answer).toContain("deploy.md");
  });

  it("rejects unsupported file types without storing them", async () => {
    const { bot, feishu, llm } = buildBot([]);
    feishu.files.set("file_zip", Buffer.from("PK\x03\x04"));

    await bot.handle(fileEvent({ fileKey: "file_zip", fileName: "archive.zip" }));

    expect(feishu.replies[0]?.text.toLowerCase()).toContain("unsupported");
    await bot.tick();
    expect(llm.embedCalls).toHaveLength(0);
  });

  it("replaces an existing Owner Document when re-sent with the same filename", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_1",
          name: "search_knowledge_base",
          arguments: { query: "release version" },
        },
      },
      { text: "最新版本是 v2。" },
    ]);
    feishu.files.set("k1", Buffer.from("Release version is v1."));
    feishu.files.set("k2", Buffer.from("Release version is v2."));

    await bot.handle(fileEvent({ messageId: "om_f1", fileKey: "k1", fileName: "release.txt" }));
    await bot.tick();
    await bot.handle(fileEvent({ messageId: "om_f2", fileKey: "k2", fileName: "release.txt" }));
    await bot.tick();

    await bot.handle(privateMessage({ messageId: "om_q1", text: "版本是多少？" }));
    const toolMessage = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("v2");
    expect(toolMessage?.content).not.toContain("v1");
  });

  it("queues indexing while LLM is offline and completes once it returns", async () => {
    const { bot, feishu, llm } = buildBot([]);
    feishu.files.set("k_pdf", Buffer.from("Important PDF notes about architecture."));
    llm.setOffline(true);

    await bot.handle(fileEvent({ fileKey: "k_pdf", fileName: "arch.pdf" }));
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("pending indexing");

    await bot.tick();
    expect(llm.embedCalls).toHaveLength(0);

    llm.setOffline(false);
    await bot.tick();
    expect(llm.embedCalls.length).toBeGreaterThan(0);
  });

  it("does not trigger Knowledge Base search on casual messages", async () => {
    const { bot, llm } = buildBot([{ text: "你好！" }]);

    await bot.handle(privateMessage({ text: "你好" }));

    expect(llm.embedCalls).toHaveLength(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("lets the Owner list and delete Owner Documents with /docs", async () => {
    const { bot, feishu } = buildBot([]);
    feishu.files.set("k1", Buffer.from("Doc content"));

    await bot.handle(fileEvent({ messageId: "om_f1", fileKey: "k1", fileName: "guide.md" }));
    await bot.handle(privateMessage({ messageId: "om_cmd1", text: "/docs" }));
    expect(feishu.replies.at(-1)?.text).toContain("guide.md");

    await bot.handle(privateMessage({ messageId: "om_cmd2", text: "/docs delete guide.md" }));
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("deleted");

    await bot.handle(privateMessage({ messageId: "om_cmd3", text: "/docs" }));
    expect(feishu.replies.at(-1)?.text).not.toContain("guide.md");
  });

  it("embeds large documents in batches", async () => {
    const { bot, feishu, llm } = buildBot([]);
    const lines = Array.from({ length: 40 * 20 }, (_, i) => `line ${i}`).join("\n");
    feishu.files.set("big", Buffer.from(lines));

    await bot.handle(fileEvent({ fileKey: "big", fileName: "big.txt" }));
    await bot.tick();

    expect(llm.embedCalls.length).toBeGreaterThan(1);
    expect(Math.max(...llm.embedCalls.map((batch) => batch.length))).toBeLessThanOrEqual(16);
  });

  it("fails a document that cannot be embedded without blocking later documents", async () => {
    const { bot, feishu, llm } = buildBot([
      { toolCall: { id: "c1", name: "search_knowledge_base", arguments: { query: "good" } } },
      { text: "找到了。" },
    ]);
    llm.failEmbedMarker = "POISON";
    feishu.files.set("bad", Buffer.from("POISON content"));
    feishu.files.set("good", Buffer.from("Good content: gamma-7."));

    await bot.handle(fileEvent({ messageId: "om_bad", fileKey: "bad", fileName: "bad.md" }));
    await bot.handle(fileEvent({ messageId: "om_good", fileKey: "good", fileName: "good.md" }));
    await bot.tick();

    await bot.handle(privateMessage({ messageId: "om_docs", text: "/docs" }));
    const docs = feishu.replies.at(-1)?.text ?? "";
    expect(docs).toContain("bad.md (failed)");
    expect(docs).toContain("good.md (indexed)");

    await bot.handle(privateMessage({ messageId: "om_q", text: "查一下" }));
    const toolMessage = llm.requests[0]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("gamma-7");
  });

  it("does not run overlapping ticks", async () => {
    let syncCalls = 0;
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const slowSync: RepositorySyncPort = {
      async sync() {
        syncCalls += 1;
        await gate;
        return { branch: "main", changedFiles: [], deletedFiles: [] };
      },
    };
    const { bot } = buildBot([], {
      settings: { repositories: ["Aotemo/demo-repo"] },
      repositorySync: slowSync,
    });

    const first = bot.tick();
    await bot.tick();
    releaseSync();
    await first;

    expect(syncCalls).toBe(1);
  });

  it("does not list a non-Owner User's Supplementary Documents in a group", async () => {
    const { bot, feishu } = buildBot([]);
    feishu.files.set("m", Buffer.from("Member doc"));
    await bot.handle(
      fileEvent({
        chatId: "oc_member_private",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        fileKey: "m",
        fileName: "private-plan.md",
      }),
    );

    await bot.handle(groupMessage({ messageId: "om_g_docs", text: "/docs" }));

    expect(feishu.replies.at(-1)?.text).not.toContain("private-plan.md");
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("private chat");
  });
});

function createLocalGitRepo(): { repoDir: string; workDir: string } {
  const base = mkdtempSync(join(tmpdir(), "per-bot-git-"));
  tempDirs.push(base);
  const repoDir = join(base, "origin");
  const workDir = join(base, "clones");
  execFileSync("git", ["init", "-b", "main", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "# Demo Repo\nLine 2: uses port 9090.\n");
  writeFileSync(join(repoDir, "old.ts"), "export const legacy = true;\n");
  execFileSync("git", ["-C", repoDir, "add", "."]);
  execFileSync("git", ["-C", repoDir, "commit", "-m", "initial"]);
  return { repoDir, workDir };
}

describe("bot core — Repository sync from private GitHub repos (#7)", () => {
  it("syncs repositories on startup and hourly, re-indexes only changed files, removes deleted files, and cites GitHub links with line numbers", async () => {
    const { repoDir, workDir } = createLocalGitRepo();
    const repoName = "Aotemo/demo-repo";
    const gitSync = createGitRepositorySync({
      cloneRoot: workDir,
      resolveCloneUrl: () => repoDir,
    });

    const { bot, feishu, llm, clock } = buildBot(
      [
        {
          toolCall: {
            id: "call_1",
            name: "search_knowledge_base",
            arguments: { query: "port 9090" },
          },
        },
        { text: "仓库使用端口 9090。" },
        {
          toolCall: {
            id: "call_2",
            name: "search_knowledge_base",
            arguments: { query: "legacy" },
          },
        },
        { text: "没有找到 legacy。" },
      ],
      {
        settings: {
          repositories: [repoName],
          memory: { proposalTtlDays: 7, extractionIdleMinutes: 120 },
        },
        repositorySync: gitSync,
      },
    );

    // Initial sync on startup tick
    await bot.tick();
    const initialEmbeds = llm.embedCalls.length;
    expect(initialEmbeds).toBe(2);

    // Answer cites GitHub link with line numbers
    await bot.handle(privateMessage({ messageId: "om_q1", text: "端口是多少？" }));
    const answer1 = feishu.replies.at(-1)?.text ?? "";
    expect(answer1).toContain("https://github.com/Aotemo/demo-repo/blob/main/README.md#L1-L2");

    // Before 1 hour passes, tick does not re-sync
    clock.advance(30 * 60 * 1000);
    await bot.tick();
    expect(llm.embedCalls.length).toBe(initialEmbeds + 1); // only +1 from the search query

    // Modify README.md and delete old.ts, then advance past 1 hour
    writeFileSync(join(repoDir, "README.md"), "# Demo Repo\nLine 2: updated port 9091.\n");
    unlinkSync(join(repoDir, "old.ts"));
    execFileSync("git", ["-C", repoDir, "add", "-A"]);
    execFileSync("git", ["-C", repoDir, "commit", "-m", "update readme and delete old"]);

    clock.advance(31 * 60 * 1000);
    await bot.tick();
    // Only the 1 changed file (README.md) is re-indexed
    expect(llm.embedCalls.length).toBe(initialEmbeds + 2);

    // Deleted file is no longer returned by search
    await bot.handle(privateMessage({ messageId: "om_q2", text: "legacy 还在吗？" }));
    const toolMsg = llm.requests.at(-1)?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).not.toContain("legacy");
  });

  it("queues repository indexing while LLM is offline and completes once it returns", async () => {
    const { repoDir, workDir } = createLocalGitRepo();
    const gitSync = createGitRepositorySync({
      cloneRoot: workDir,
      resolveCloneUrl: () => repoDir,
    });
    const { bot, llm } = buildBot([], {
      settings: { repositories: ["Aotemo/demo-repo"] },
      repositorySync: gitSync,
    });

    llm.setOffline(true);
    await bot.tick();
    expect(llm.embedCalls).toHaveLength(0);

    llm.setOffline(false);
    await bot.tick();
    expect(llm.embedCalls.length).toBe(2);
  });
});

describe("bot core — Supplementary Documents (#8)", () => {
  it("stores a non-Owner User's file (even sent in a group) as a Supplementary Document searchable only in their private chat", async () => {
    const bobId = "ou_bob";
    const { bot, feishu, llm } = buildBot(
      [
        // 1. Member private chat -> sees member's supplementary doc
        {
          toolCall: {
            id: "call_1",
            name: "search_knowledge_base",
            arguments: { query: "secret draft" },
          },
        },
        { text: "你的草稿里写着 secret draft。" },
        // 2. Group chat by member -> must NOT see member's supplementary doc
        {
          toolCall: {
            id: "call_2",
            name: "search_knowledge_base",
            arguments: { query: "secret draft" },
          },
        },
        { text: "群里没找到相关文档。" },
        // 3. Another user's private chat -> must NOT see member's supplementary doc
        {
          toolCall: {
            id: "call_3",
            name: "search_knowledge_base",
            arguments: { query: "secret draft" },
          },
        },
        { text: "没找到相关文档。" },
      ],
      { groups: { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID, bobId] } },
    );
    feishu.files.set("supp_1", Buffer.from("Member secret draft notes: alpha-42."));

    // Sent in group by Member
    await bot.handle(
      fileEvent({
        chatType: "group",
        chatId: ALLOWED_GROUP_ID,
        topicId: "om_group_root",
        messageId: "om_supp_1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        fileKey: "supp_1",
        fileName: "member-notes.md",
      }),
    );
    expect(feishu.replies[0]?.text.toLowerCase()).toContain("pending indexing");
    await bot.tick();

    // 1. Member private chat -> finds it
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_q1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "我的草稿写了什么？",
      }),
    );
    const tool1 = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(tool1?.content).toContain("alpha-42");

    // 2. Group chat -> does NOT find it
    await bot.handle(
      groupMessage({
        topicId: "om_g2",
        messageId: "om_q2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        mentionsBot: true,
        text: "查一下 alpha-42",
      }),
    );
    const tool2 = llm.requests[3]?.messages.find((m) => m.role === "tool");
    expect(tool2?.content).not.toContain("alpha-42");

    // 3. Bob's private chat -> does NOT find it
    await bot.handle(
      privateMessage({
        chatId: "oc_bob_private",
        messageId: "om_q3",
        sender: { openId: bobId, name: "Bob" },
        text: "查一下 alpha-42",
      }),
    );
    const tool3 = llm.requests[5]?.messages.find((m) => m.role === "tool");
    expect(tool3?.content).not.toContain("alpha-42");
  });

  it("lets a non-Owner User list and delete their own Supplementary Documents with /docs", async () => {
    const { bot, feishu } = buildBot([]);
    feishu.files.set("owner_f", Buffer.from("Owner doc"));
    feishu.files.set("member_f", Buffer.from("Member doc"));

    await bot.handle(fileEvent({ messageId: "om_o1", fileKey: "owner_f", fileName: "owner.md" }));
    await bot.handle(
      fileEvent({
        chatId: "oc_member_private",
        messageId: "om_m1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        fileKey: "member_f",
        fileName: "mine.md",
      }),
    );

    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_cmd1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/docs",
      }),
    );
    expect(feishu.replies.at(-1)?.text).toContain("mine.md");
    expect(feishu.replies.at(-1)?.text).not.toContain("owner.md");

    // Cannot delete Owner's doc
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_cmd2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/docs delete owner.md",
      }),
    );
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("not found");

    // Can delete own doc
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_cmd3",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/docs delete mine.md",
      }),
    );
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("deleted");
  });
});

describe("bot core — Promotion of Supplementary Documents (#9)", () => {
  it("sends the Owner a Promotion card and makes the document searchable in groups once promoted, recording original uploader", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_1",
          name: "search_knowledge_base",
          arguments: { query: "runbook" },
        },
      },
      { text: "手册说明了重启步骤。" },
    ]);
    feishu.files.set("supp_runbook", Buffer.from("Runbook: restart with systemctl restart app."));

    await bot.handle(
      fileEvent({
        chatId: "oc_member_private",
        messageId: "om_supp_rb",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        fileKey: "supp_runbook",
        fileName: "runbook.md",
      }),
    );
    await bot.tick();

    expect(feishu.cards).toHaveLength(1);
    const card = feishu.cards[0];
    expect(card?.openId).toBe(OWNER_OPEN_ID);
    const promoteAction = card?.items[0]?.actions.find((a) => a.action === "promote_document");
    expect(promoteAction).toBeDefined();

    // Non-Owner attempting to click Promote is ignored
    await bot.handle({
      kind: "card_action",
      cardId: card?.cardId ?? "",
      action: "promote_document",
      payload: promoteAction?.payload ?? {},
      actorOpenId: MEMBER_OPEN_ID,
    });

    // Owner clicks Promote
    await bot.handle({
      kind: "card_action",
      cardId: card?.cardId ?? "",
      action: "promote_document",
      payload: promoteAction?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Now searchable in a group
    await bot.handle(
      groupMessage({
        topicId: "om_g_promo",
        messageId: "om_q_promo",
        text: "怎么重启服务？",
      }),
    );
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("systemctl restart app");

    // Owner /docs shows promoted document and its original uploader
    await bot.handle(privateMessage({ messageId: "om_docs_owner", text: "/docs" }));
    const docsReply = feishu.replies.at(-1)?.text ?? "";
    expect(docsReply).toContain("runbook.md");
    expect(docsReply).toContain(MEMBER_OPEN_ID);
  });

  it("keeps the document supplementary when the Owner chooses Keep", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_1",
          name: "search_knowledge_base",
          arguments: { query: "draft note" },
        },
      },
      { text: "群里没找到。" },
    ]);
    feishu.files.set("supp_keep", Buffer.from("Private draft note: zeta-99."));

    await bot.handle(
      fileEvent({
        chatId: "oc_member_private",
        messageId: "om_supp_keep",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        fileKey: "supp_keep",
        fileName: "draft.md",
      }),
    );
    await bot.tick();

    const card = feishu.cards[0];
    const keepAction = card?.items[0]?.actions.find((a) => a.action === "keep_supplementary");
    expect(keepAction).toBeDefined();

    await bot.handle({
      kind: "card_action",
      cardId: card?.cardId ?? "",
      action: "keep_supplementary",
      payload: keepAction?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    await bot.handle(
      groupMessage({
        topicId: "om_g_keep",
        messageId: "om_q_keep",
        text: "zeta-99 是什么？",
      }),
    );
    const toolMsg = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).not.toContain("zeta-99");
  });
});

describe("bot core — Escalation to the Owner (#10)", () => {
  it("privately notifies the Owner with the question and a link when escalate_to_owner is called, without @-mentioning the Owner in the group", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_esc_1",
          name: "escalate_to_owner",
          arguments: { reason: "Not found in Knowledge Base" },
        },
      },
      { text: "我不知道这个问题的答案，已经私聊通知 Owner 了。" },
    ]);

    await bot.handle(
      groupMessage({
        topicId: "om_esc_topic",
        messageId: "om_esc_q",
        text: "下周发布计划定在周几？",
      }),
    );

    const system = llm.requests[0]?.messages.find((m) => m.role === "system");
    expect(system?.content.toLowerCase()).toContain("escalate");

    expect(feishu.privateMessages).toHaveLength(1);
    expect(feishu.privateMessages[0]?.openId).toBe(OWNER_OPEN_ID);
    expect(feishu.privateMessages[0]?.text).toContain("下周发布计划定在周几？");
    expect(feishu.privateMessages[0]?.text).toContain("https://");
    expect(feishu.privateMessages[0]?.text).toContain("om_esc_q");

    expect(feishu.replies).toHaveLength(1);
    expect(feishu.replies[0]?.text).toContain("不知道");
    expect(feishu.replies[0]?.text).not.toContain(`@${OWNER_OPEN_ID}`);
    expect(feishu.replies[0]?.text).not.toContain("<at");
  });
});

describe("bot core — Memory core: /remember and Owner approval (#11)", () => {
  it("creates a Memory Proposal via /remember, keeps it inactive until approved, and scopes Memories to Owner + asker only", async () => {
    const bobId = "ou_bob";
    const { bot, feishu, llm } = buildBot(
      [{ text: "未批准前回复" }, { text: "批准后给 Member 回复" }, { text: "批准后给 Bob 回复" }],
      { groups: { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID, bobId] } },
    );

    // Owner submits a memory and approves it
    await bot.handle(
      privateMessage({ messageId: "om_r_owner", text: "/remember Prefers TypeScript over Python" }),
    );
    const ownerCard = feishu.cards[0];
    expect(ownerCard?.openId).toBe(OWNER_OPEN_ID);
    const acceptOwner = ownerCard?.items[0]?.actions.find((a) => a.action === "accept_memory");
    await bot.handle({
      kind: "card_action",
      cardId: ownerCard?.cardId ?? "",
      action: "accept_memory",
      payload: acceptOwner?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Member submits a memory — NOT yet approved
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_r_member",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/remember Works on mobile app",
      }),
    );
    expect(feishu.cards).toHaveLength(2);

    // Before approval: Member's proposal does NOT appear in system prompt
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_q1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "你好",
      }),
    );
    const sys1 = llm.requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys1).toContain("Prefers TypeScript over Python");
    expect(sys1).not.toContain("Works on mobile app");

    // Owner approves Member's memory with Edit
    const memberCard = feishu.cards[1];
    const editAction = memberCard?.items[0]?.actions.find((a) => a.action === "edit_memory");
    await bot.handle({
      kind: "card_action",
      cardId: memberCard?.cardId ?? "",
      action: "edit_memory",
      payload: { ...(editAction?.payload ?? {}), text: "Works on iOS app" },
      actorOpenId: OWNER_OPEN_ID,
    });

    // Member now sees Owner's Memory + their own Memory
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_q2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "再问一下",
      }),
    );
    const sys2 = llm.requests[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys2).toContain("Prefers TypeScript over Python");
    expect(sys2).toContain("Works on iOS app");

    // Bob sees Owner's Memory, NEVER Member's Memory
    await bot.handle(
      privateMessage({
        chatId: "oc_bob_private",
        messageId: "om_q3",
        sender: { openId: bobId, name: "Bob" },
        text: "Bob 提问",
      }),
    );
    const sys3 = llm.requests[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys3).toContain("Prefers TypeScript over Python");
    expect(sys3).not.toContain("Works on iOS app");
  });

  it("supports rejecting proposals and expires unreviewed proposals after 7 days", async () => {
    const { bot, feishu, llm, clock } = buildBot([{ text: "回复" }]);

    await bot.handle(privateMessage({ messageId: "om_r1", text: "/remember Rejected fact" }));
    const rejectCard = feishu.cards[0];
    const rejectAction = rejectCard?.items[0]?.actions.find((a) => a.action === "reject_memory");
    await bot.handle({
      kind: "card_action",
      cardId: rejectCard?.cardId ?? "",
      action: "reject_memory",
      payload: rejectAction?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    await bot.handle(privateMessage({ messageId: "om_r2", text: "/remember Stale fact" }));
    const expireCard = feishu.cards[1];
    const acceptStale = expireCard?.items[0]?.actions.find((a) => a.action === "accept_memory");

    // Advance 7 days + 1 second
    clock.advance(7 * 24 * 60 * 60 * 1000 + 1000);
    await bot.tick();

    // Trying to accept after expiry does nothing
    await bot.handle({
      kind: "card_action",
      cardId: expireCard?.cardId ?? "",
      action: "accept_memory",
      payload: acceptStale?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    await bot.handle(privateMessage({ messageId: "om_q_exp", text: "检查记忆" }));
    const sys = llm.requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys).not.toContain("Rejected fact");
    expect(sys).not.toContain("Stale fact");
  });

  it("lets Users list/forget their own Memories and lets the Owner manage anyone's Memories", async () => {
    const { bot, feishu } = buildBot([]);

    // Owner memory
    await bot.handle(privateMessage({ messageId: "om_r1", text: "/remember Owner fact" }));
    await bot.handle({
      kind: "card_action",
      cardId: feishu.cards[0]?.cardId ?? "",
      action: "accept_memory",
      payload: feishu.cards[0]?.items[0]?.actions[0]?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Member memory
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_r2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/remember Member fact",
      }),
    );
    await bot.handle({
      kind: "card_action",
      cardId: feishu.cards[1]?.cardId ?? "",
      action: "accept_memory",
      payload: feishu.cards[1]?.items[0]?.actions[0]?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Member lists own memories (only sees Member fact)
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_m_list",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/memories",
      }),
    );
    const memberList = feishu.replies.at(-1)?.text ?? "";
    expect(memberList).toContain("Member fact");
    expect(memberList).not.toContain("Owner fact");

    // Member cannot forget Owner's memory (#1)
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_m_forget_1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/forget 1",
      }),
    );
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("not found");

    // Owner lists all memories (sees both) and deletes Member's memory (#2)
    await bot.handle(privateMessage({ messageId: "om_o_list", text: "/memories" }));
    const ownerList = feishu.replies.at(-1)?.text ?? "";
    expect(ownerList).toContain("Owner fact");
    expect(ownerList).toContain("Member fact");

    await bot.handle(privateMessage({ messageId: "om_o_forget_2", text: "/forget 2" }));
    expect(feishu.replies.at(-1)?.text.toLowerCase()).toContain("deleted");

    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_m_list_2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/memories",
      }),
    );
    expect(feishu.replies.at(-1)?.text).not.toContain("Member fact");
  });
});

describe("bot core — Model-proposed Memories (#12)", () => {
  it("exposes propose_memory(fact), attributes the Proposal to the current speaker, and excludes sensitive info in the system prompt", async () => {
    const { bot, feishu, llm } = buildBot([
      {
        toolCall: {
          id: "call_mem_1",
          name: "propose_memory",
          arguments: { fact: "Uses Neovim as primary editor" },
        },
      },
      { text: "好的，我记住你主要用 Neovim 了（等 Owner 审批后生效）。" },
      { text: "第二轮回复" },
    ]);

    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_p1",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "我平时主要用 Neovim 写代码",
      }),
    );

    const system = llm.requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system.toLowerCase()).toContain("sensitive");
    expect(llm.requests[0]?.tools.some((t) => t.name === "propose_memory")).toBe(true);

    expect(feishu.cards).toHaveLength(1);
    const card = feishu.cards[0];
    expect(card?.openId).toBe(OWNER_OPEN_ID);
    expect(card?.items[0]?.text).toContain(MEMBER_OPEN_ID);
    expect(card?.items[0]?.text).toContain("Uses Neovim as primary editor");

    // Approve and verify it is attributed to Member
    const accept = card?.items[0]?.actions.find((a) => a.action === "accept_memory");
    await bot.handle({
      kind: "card_action",
      cardId: card?.cardId ?? "",
      action: "accept_memory",
      payload: accept?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_p2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "我用什么编辑器？",
      }),
    );
    const sys2 = llm.requests[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sys2).toContain("Uses Neovim as primary editor");
  });
});

describe("bot core — Idle extraction of Memories (#13)", () => {
  it("runs after 30 minutes of idle time (reset by new messages), passes existing Memories for updates, filters attribution to actual speakers, batches into one card, and waits when offline", async () => {
    const bobId = "ou_bob";
    const { bot, feishu, llm, clock } = buildBot(
      [
        // 1. Reply to Bob's message
        { text: "好的。" },
        // 1b. Reply to Member's message
        { text: "收到，了解了。" },
        // 2. Idle extraction LLM output: 1 update for Member, 1 add for Bob, 1 invalid speaker attribution (should be dropped)
        {
          text: JSON.stringify({
            proposals: [
              {
                speakerOpenId: MEMBER_OPEN_ID,
                op: "update",
                memoryId: 1,
                fact: "Uses Go for backend services",
              },
              {
                speakerOpenId: bobId,
                op: "add",
                fact: "Maintains the CI pipeline",
              },
              {
                speakerOpenId: "ou_unspoken_person",
                op: "add",
                fact: "Should never be attributed",
              },
            ],
          }),
        },
        // 3. Follow-up check for Member
        { text: "已更新记忆。" },
      ],
      { groups: { [ALLOWED_GROUP_ID]: [OWNER_OPEN_ID, MEMBER_OPEN_ID, bobId] } },
    );

    // Seed an existing Memory (#1) for Member
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_seed",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "/remember Uses Java for backend services",
      }),
    );
    await bot.handle({
      kind: "card_action",
      cardId: feishu.cards[0]?.cardId ?? "",
      action: "accept_memory",
      payload: feishu.cards[0]?.items[0]?.actions[0]?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Multi-person group topic
    await bot.handle(
      groupMessage({
        topicId: "om_idle_topic",
        messageId: "om_i1",
        sender: { openId: bobId, name: "Bob" },
        mentionsBot: true,
        text: "我负责维护 CI 流水线",
      }),
    );

    // Advance 20 minutes, then Member posts -> resets the 30-minute timer
    clock.advance(20 * 60 * 1000);
    await bot.handle(
      groupMessage({
        topicId: "om_idle_topic",
        messageId: "om_i2",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        mentionsBot: true,
        text: "我现在后端改用 Go 了",
      }),
    );

    // Advance 20 minutes (only 20m since last message, 40m since first) -> must NOT extract yet
    clock.advance(20 * 60 * 1000);
    await bot.tick();
    expect(feishu.cards).toHaveLength(1); // only the initial /remember card

    // Advance another 11 minutes (31m since last message) while LLM is offline -> must wait
    clock.advance(11 * 60 * 1000);
    llm.setOffline(true);
    await bot.tick();
    expect(feishu.cards).toHaveLength(1);

    // LLM comes back online -> extraction runs and sends ONE batched card
    llm.setOffline(false);
    await bot.tick();

    expect(feishu.cards).toHaveLength(2);
    const extractionReq = llm.requests[2];
    const extractionPrompt = extractionReq?.messages.map((m) => m.content).join("\n") ?? "";
    expect(extractionPrompt).toContain("Uses Java for backend services");
    expect(extractionPrompt.toLowerCase()).toContain("sensitive");

    const batchCard = feishu.cards[1];
    expect(batchCard?.openId).toBe(OWNER_OPEN_ID);
    expect(batchCard?.items).toHaveLength(2); // ou_unspoken_person was dropped!
    expect(batchCard?.items[0]?.actions.map((a) => a.action)).toEqual([
      "accept_memory",
      "edit_memory",
      "reject_memory",
    ]);

    // Accept the update proposal for Member
    const acceptUpdate = batchCard?.items[0]?.actions.find((a) => a.action === "accept_memory");
    await bot.handle({
      kind: "card_action",
      cardId: batchCard?.cardId ?? "",
      action: "accept_memory",
      payload: acceptUpdate?.payload ?? {},
      actorOpenId: OWNER_OPEN_ID,
    });

    // Verify Member's Memory was updated (not duplicated)
    await bot.handle(
      privateMessage({
        chatId: "oc_member_private",
        messageId: "om_check_upd",
        sender: { openId: MEMBER_OPEN_ID, name: "Member" },
        text: "我用什么写后端？",
      }),
    );
    const sysAfter = llm.requests[3]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sysAfter).toContain("Uses Go for backend services");
    expect(sysAfter).not.toContain("Uses Java for backend services");
  });
});
