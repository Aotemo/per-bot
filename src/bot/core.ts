import type {
  InboundCardAction,
  InboundEvent,
  InboundFile,
  InboundMessage,
} from "../domain/inbound";
import {
  chunkText,
  extractDocumentText,
  isSupportedFileName,
  serializeEmbedding,
} from "../knowledge/documents";
import type { Clock } from "../ports/clock";
import type { FeishuPort } from "../ports/feishu";
import type { ChatMessage, LlmPort, ToolDefinition } from "../ports/llm";
import type { RepositorySyncPort } from "../ports/repository-sync";
import type { Storage } from "../storage/database";

export type RateLimitSettings = {
  maxRequests: number;
  windowSeconds: number;
};

export type MemorySettings = {
  proposalTtlDays: number;
  extractionIdleMinutes: number;
};

export type BotSettings = {
  ownerOpenId: string;
  chatModel: string;
  allowedGroups: string[];
  repositories?: string[];
  syncIntervalMs?: number;
  rateLimit?: RateLimitSettings;
  memory?: MemorySettings;
};

export type BotDependencies = {
  settings: BotSettings;
  storage: Storage;
  feishu: FeishuPort;
  llm: LlmPort;
  repositorySync: RepositorySyncPort;
  clock: Clock;
};

export type Bot = {
  handle(event: InboundEvent): Promise<void>;
  tick(): Promise<void>;
};

const GROUP_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT: RateLimitSettings = { maxRequests: 10, windowSeconds: 60 };
const DEFAULT_MEMORY_SETTINGS: MemorySettings = { proposalTtlDays: 7, extractionIdleMinutes: 30 };
const MAX_TOOL_ROUNDS = 5;
const NO_PERMISSION_REPLY = "Sorry, you do not have permission to use this bot.";
const MODEL_OFFLINE_REPLY = "The model is currently offline. Please try again later.";
const RATE_LIMITED_REPLY = "You have reached the rate limit. Please wait a moment and try again.";
const THINKING_REPLY = "Thinking...";

const SYSTEM_PROMPT = [
  "You are the personal assistant of the Owner, speaking on their behalf to people who talk to the bot.",
  "Never pretend to be the Owner: refer to the Owner in the third person when it matters.",
  "Answer in the language the user asked in.",
  "Use search_knowledge_base before answering factual questions about the Owner's work, documents, or code.",
  "Do not call search_knowledge_base for casual greetings or small talk.",
  "When you use search_knowledge_base, cite the document filename or repository link.",
  "When the current speaker states a durable, public fact or preference about themselves, call propose_memory(fact).",
  "All Memories are public: never propose sensitive personal information (family, health, credentials, passwords, financial details, etc.).",
  "If you cannot answer from the Knowledge Base and Memories, say you do not know and call escalate_to_owner instead of guessing.",
  "Never @-mention the Owner in a group chat.",
].join("\n");

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable, public facts or preferences from a Conversation for Memory Proposals.",
  "Rules:",
  "1. Attribute each fact ONLY to the User who stated it about themselves. Never attribute claims made about someone else.",
  "2. All Memories are public: NEVER extract sensitive personal information (family, health, credentials, passwords, financial details, addresses, etc.).",
  "3. Compare against each speaker's existing Memories. If a new fact updates or conflicts with an existing Memory, output op='update' with that memoryId; otherwise output op='add'.",
  '4. Respond with JSON only: {"proposals": [{"speakerOpenId": "...", "op": "add"|"update", "memoryId": number|null, "fact": "..."}]}.',
].join("\n");

const SEARCH_KB_TOOL: ToolDefinition = {
  name: "search_knowledge_base",
  description:
    "Search the Knowledge Base (Repositories, Owner Documents, and Promoted documents) for relevant context.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  },
};

const PROPOSE_MEMORY_TOOL: ToolDefinition = {
  name: "propose_memory",
  description:
    "Propose a durable, public, non-sensitive fact or preference about the current speaker to be remembered after Owner approval.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The durable fact about the current speaker" },
    },
    required: ["fact"],
  },
};

const ESCALATE_TOOL: ToolDefinition = {
  name: "escalate_to_owner",
  description:
    "Privately notify the Owner with a link to the question when you cannot answer from the Knowledge Base and Memories.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the question could not be answered" },
    },
    required: ["reason"],
  },
};

type SearchHit = {
  document_id: number;
  kind: string;
  name: string;
  repo_name: string | null;
  repo_branch: string | null;
  file_path: string | null;
  content: string;
  start_line: number;
  end_line: number;
  distance: number;
};

export function createBot(dependencies: BotDependencies): Bot {
  const { settings, storage, feishu, llm, repositorySync, clock } = dependencies;
  const { db } = storage;
  const allowedGroupSet = new Set(settings.allowedGroups);
  const repositories = settings.repositories ?? [];
  const syncIntervalMs = settings.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const rateLimit = settings.rateLimit ?? DEFAULT_RATE_LIMIT;
  const memorySettings = settings.memory ?? DEFAULT_MEMORY_SETTINGS;
  const proposalTtlMs = memorySettings.proposalTtlDays * 24 * 60 * 60 * 1000;
  const extractionIdleMs = memorySettings.extractionIdleMinutes * 60 * 1000;
  let queueDepth = 0;
  let queueTail: Promise<void> = Promise.resolve();

  const countRateLimitEvents = db.prepare<[string, number], { count: number }>(
    "SELECT COUNT(*) AS count FROM rate_limit_events WHERE open_id = ? AND created_at > ?",
  );
  const insertRateLimitEvent = db.prepare<[string, number]>(
    "INSERT INTO rate_limit_events (open_id, created_at) VALUES (?, ?)",
  );

  const selectGroupCacheMeta = db.prepare<[string], { fetched_at: number }>(
    "SELECT fetched_at FROM group_cache_meta WHERE chat_id = ?",
  );
  const selectGroupMember = db.prepare<[string, string], { open_id: string }>(
    "SELECT open_id FROM group_members_cache WHERE chat_id = ? AND open_id = ?",
  );
  const deleteGroupMembers = db.prepare<[string]>(
    "DELETE FROM group_members_cache WHERE chat_id = ?",
  );
  const insertGroupMember = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO group_members_cache (chat_id, open_id) VALUES (?, ?)",
  );
  const upsertGroupCacheMeta = db.prepare<[string, number]>(
    "INSERT INTO group_cache_meta (chat_id, fetched_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET fetched_at = excluded.fetched_at",
  );

  const saveGroupMembers = db.transaction((chatId: string, members: string[], nowMs: number) => {
    deleteGroupMembers.run(chatId);
    for (const openId of members) {
      insertGroupMember.run(chatId, openId);
    }
    upsertGroupCacheMeta.run(chatId, nowMs);
  });

  const upsertConversation = db.prepare<[string, string, string, number, number]>(
    `INSERT INTO conversations (topic_id, chat_id, chat_type, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET last_message_at = excluded.last_message_at`,
  );
  const insertConversationMessage = db.prepare<
    [string, string | null, string, string | null, string | null, string, number]
  >(
    `INSERT INTO conversation_messages
     (topic_id, message_id, role, sender_open_id, sender_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectConversationMessages = db.prepare<
    [string],
    {
      role: "user" | "assistant";
      sender_open_id: string | null;
      sender_name: string | null;
      content: string;
    }
  >(
    `SELECT role, sender_open_id, sender_name, content
     FROM conversation_messages
     WHERE topic_id = ?
     ORDER BY id ASC`,
  );

  const findExistingDocByName = db.prepare<[string, string, string], { id: number }>(
    "SELECT id FROM documents WHERE kind = ? AND uploader_open_id = ? AND name = ?",
  );
  const findExistingRepoDoc = db.prepare<[string, string], { id: number }>(
    "SELECT id FROM documents WHERE kind = 'repository' AND repo_name = ? AND file_path = ?",
  );
  const deleteDocumentById = db.prepare<[number]>("DELETE FROM documents WHERE id = ?");
  const insertDocument = db.prepare<
    [string, string, string, string | null, string | null, string | null, string, number, number]
  >(
    `INSERT INTO documents
     (kind, name, uploader_open_id, repo_name, repo_branch, file_path, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const selectRepoSyncState = db.prepare<[string], { last_synced_at: number; branch: string }>(
    "SELECT last_synced_at, branch FROM repo_sync_state WHERE repo_name = ?",
  );
  const upsertRepoSyncState = db.prepare<[string, number, string]>(
    `INSERT INTO repo_sync_state (repo_name, last_synced_at, branch)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_name) DO UPDATE SET last_synced_at = excluded.last_synced_at, branch = excluded.branch`,
  );
  const insertIndexJob = db.prepare<[number, number]>(
    "INSERT INTO index_jobs (document_id, status, created_at) VALUES (?, 'pending', ?)",
  );
  const selectPendingJobs = db.prepare<
    [],
    { job_id: number; document_id: number; content: string }
  >(
    `SELECT j.id AS job_id, j.document_id, d.content
     FROM index_jobs j
     JOIN documents d ON d.id = j.document_id
     WHERE j.status = 'pending'
     ORDER BY j.id ASC`,
  );
  const deleteDocumentChunks = db.prepare<[number]>(
    "DELETE FROM document_chunks WHERE document_id = ?",
  );
  const insertDocumentChunk = db.prepare<[number, number, string, number, number, Buffer]>(
    `INSERT INTO document_chunks (document_id, chunk_index, content, start_line, end_line, embedding)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const markDocumentIndexed = db.prepare<[number, number]>(
    "UPDATE documents SET status = 'indexed', updated_at = ? WHERE id = ?",
  );
  const markJobDone = db.prepare<[number, number]>(
    "UPDATE index_jobs SET status = 'done', completed_at = ? WHERE id = ?",
  );
  const listOwnerDocs = db.prepare<
    [],
    { id: number; kind: string; name: string; status: string; uploader_open_id: string }
  >(
    "SELECT id, kind, name, status, uploader_open_id FROM documents WHERE kind IN ('owner', 'promoted') ORDER BY name ASC",
  );
  const selectDocumentById = db.prepare<
    [number],
    { id: number; kind: string; name: string; uploader_open_id: string }
  >("SELECT id, kind, name, uploader_open_id FROM documents WHERE id = ?");
  const promoteDocumentById = db.prepare<[number, number]>(
    "UPDATE documents SET kind = 'promoted', updated_at = ? WHERE id = ? AND kind = 'supplementary'",
  );

  type MemoryRow = { id: number; user_open_id: string; content: string };
  type ProposalRow = {
    id: number;
    user_open_id: string;
    content: string;
    source: string;
    target_memory_id: number | null;
    status: string;
    card_id: string | null;
    expires_at: number;
  };

  const selectMemoriesByUser = db.prepare<[string], MemoryRow>(
    "SELECT id, user_open_id, content FROM memories WHERE user_open_id = ? ORDER BY id ASC",
  );
  const selectAllMemories = db.prepare<[], MemoryRow>(
    "SELECT id, user_open_id, content FROM memories ORDER BY id ASC",
  );
  const selectMemoryById = db.prepare<[number], MemoryRow>(
    "SELECT id, user_open_id, content FROM memories WHERE id = ?",
  );
  const insertMemory = db.prepare<[string, string, number, number]>(
    "INSERT INTO memories (user_open_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  const updateMemoryContent = db.prepare<[string, number, number]>(
    "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?",
  );
  const deleteMemoryById = db.prepare<[number]>("DELETE FROM memories WHERE id = ?");

  const insertMemoryProposal = db.prepare<[string, string, string, number | null, number, number]>(
    `INSERT INTO memory_proposals
     (user_open_id, content, source, target_memory_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const updateProposalCardId = db.prepare<[string, number]>(
    "UPDATE memory_proposals SET card_id = ? WHERE id = ?",
  );
  const selectProposalById = db.prepare<[number], ProposalRow>(
    `SELECT id, user_open_id, content, source, target_memory_id, status, card_id, expires_at
     FROM memory_proposals WHERE id = ?`,
  );
  const selectProposalsByCardId = db.prepare<[string], ProposalRow>(
    `SELECT id, user_open_id, content, source, target_memory_id, status, card_id, expires_at
     FROM memory_proposals WHERE card_id = ? ORDER BY id ASC`,
  );
  const resolveProposal = db.prepare<[string, number, number]>(
    "UPDATE memory_proposals SET status = ?, resolved_at = ? WHERE id = ?",
  );
  const expirePendingProposals = db.prepare<[number, number]>(
    "UPDATE memory_proposals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?",
  );
  const selectIdleConversations = db.prepare<
    [number],
    { topic_id: string; chat_id: string; last_message_at: number }
  >(
    `SELECT topic_id, chat_id, last_message_at
     FROM conversations
     WHERE last_message_at <= ?
       AND (last_extracted_at IS NULL OR last_extracted_at < last_message_at)
     ORDER BY last_message_at ASC`,
  );
  const markConversationExtracted = db.prepare<[number, string]>(
    "UPDATE conversations SET last_extracted_at = ? WHERE topic_id = ?",
  );
  const listUserSupplementaryDocs = db.prepare<
    [string],
    { id: number; kind: string; name: string; status: string; uploader_open_id: string }
  >(
    "SELECT id, kind, name, status, uploader_open_id FROM documents WHERE kind = 'supplementary' AND uploader_open_id = ? ORDER BY name ASC",
  );
  const searchKbChunks = db.prepare<[Buffer], SearchHit>(
    `SELECT
       d.id AS document_id,
       d.kind,
       d.name,
       d.repo_name,
       d.repo_branch,
       d.file_path,
       c.content,
       c.start_line,
       c.end_line,
       vec_distance_cosine(c.embedding, ?) AS distance
     FROM document_chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.status = 'indexed'
       AND d.kind IN ('owner', 'promoted', 'repository')
     ORDER BY distance ASC
     LIMIT 5`,
  );
  const searchKbWithSupplementaryChunks = db.prepare<[Buffer, string], SearchHit>(
    `SELECT
       d.id AS document_id,
       d.kind,
       d.name,
       d.repo_name,
       d.repo_branch,
       d.file_path,
       c.content,
       c.start_line,
       c.end_line,
       vec_distance_cosine(c.embedding, ?) AS distance
     FROM document_chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.status = 'indexed'
       AND (
         d.kind IN ('owner', 'promoted', 'repository')
         OR (d.kind = 'supplementary' AND d.uploader_open_id = ?)
       )
     ORDER BY distance ASC
     LIMIT 5`,
  );

  const upsertAndEnqueueDocument = db.transaction(
    (
      kind: string,
      name: string,
      uploaderOpenId: string,
      content: string,
      nowMs: number,
    ): number => {
      const existing = findExistingDocByName.get(kind, uploaderOpenId, name);
      if (existing) {
        deleteDocumentById.run(existing.id);
      }
      const result = insertDocument.run(
        kind,
        name,
        uploaderOpenId,
        null,
        null,
        null,
        content,
        nowMs,
        nowMs,
      );
      const docId = Number(result.lastInsertRowid);
      insertIndexJob.run(docId, nowMs);
      return docId;
    },
  );

  const applyRepositorySync = db.transaction(
    (
      repoName: string,
      branch: string,
      changedFiles: Array<{ path: string; content: string }>,
      deletedFiles: string[],
      nowMs: number,
    ) => {
      for (const deletedPath of deletedFiles) {
        const existing = findExistingRepoDoc.get(repoName, deletedPath);
        if (existing) {
          deleteDocumentById.run(existing.id);
        }
      }
      for (const file of changedFiles) {
        const existing = findExistingRepoDoc.get(repoName, file.path);
        if (existing) {
          deleteDocumentById.run(existing.id);
        }
        const result = insertDocument.run(
          "repository",
          `${repoName}/${file.path}`,
          settings.ownerOpenId,
          repoName,
          branch,
          file.path,
          file.content,
          nowMs,
          nowMs,
        );
        insertIndexJob.run(Number(result.lastInsertRowid), nowMs);
      }
      upsertRepoSyncState.run(repoName, nowMs, branch);
    },
  );

  const saveIndexedChunks = db.transaction(
    (
      jobId: number,
      documentId: number,
      chunks: Array<{ content: string; startLine: number; endLine: number }>,
      embeddings: number[][],
      nowMs: number,
    ) => {
      deleteDocumentChunks.run(documentId);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) {
          continue;
        }
        insertDocumentChunk.run(
          documentId,
          i,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          serializeEmbedding(embedding),
        );
      }
      markDocumentIndexed.run(nowMs, documentId);
      markJobDone.run(nowMs, jobId);
    },
  );

  function checkAndRecordRateLimit(openId: string): boolean {
    if (openId === settings.ownerOpenId) {
      return true;
    }
    const nowMs = clock.now().getTime();
    const cutoff = nowMs - rateLimit.windowSeconds * 1000;
    const row = countRateLimitEvents.get(openId, cutoff);
    if ((row?.count ?? 0) >= rateLimit.maxRequests) {
      return false;
    }
    insertRateLimitEvent.run(openId, nowMs);
    return true;
  }

  function enqueueLlmWork(
    work: () => Promise<void>,
    onQueued?: () => Promise<void>,
  ): Promise<void> {
    const isBusy = queueDepth > 0;
    queueDepth += 1;

    const notifyPromise = isBusy && onQueued ? onQueued() : Promise.resolve();
    const previous = queueTail;
    const run = (async () => {
      await notifyPromise;
      await previous;
      try {
        await work();
      } finally {
        queueDepth -= 1;
      }
    })();

    queueTail = run.catch(() => {});
    return run;
  }

  function recordMessage(
    topicId: string,
    chatId: string,
    chatType: string,
    role: "user" | "assistant",
    content: string,
    options: { messageId?: string; senderOpenId?: string; senderName?: string | null } = {},
  ): void {
    const nowMs = clock.now().getTime();
    upsertConversation.run(topicId, chatId, chatType, nowMs, nowMs);
    insertConversationMessage.run(
      topicId,
      options.messageId ?? null,
      role,
      options.senderOpenId ?? null,
      options.senderName ?? null,
      content,
      nowMs,
    );
  }

  function formatHistoryMessages(topicId: string): ChatMessage[] {
    const rows = selectConversationMessages.all(topicId);
    return rows.map((row) => {
      if (row.role === "assistant") {
        return { role: "assistant", content: row.content };
      }
      const speaker = row.sender_name ?? row.sender_open_id ?? "User";
      return { role: "user", content: `${speaker}: ${row.content}` };
    });
  }

  async function ensureGroupCached(chatId: string): Promise<void> {
    const nowMs = clock.now().getTime();
    const meta = selectGroupCacheMeta.get(chatId);
    if (meta && nowMs - meta.fetched_at < GROUP_CACHE_TTL_MS) {
      return;
    }
    const members = await feishu.listGroupMembers(chatId);
    saveGroupMembers(chatId, members, nowMs);
  }

  async function isAuthorizedUser(openId: string): Promise<boolean> {
    if (openId === settings.ownerOpenId) {
      return true;
    }
    for (const groupId of settings.allowedGroups) {
      await ensureGroupCached(groupId);
      if (selectGroupMember.get(groupId, openId)) {
        return true;
      }
    }
    return false;
  }

  async function syncRepositories(): Promise<void> {
    if (repositories.length === 0) {
      return;
    }
    const nowMs = clock.now().getTime();
    for (const repo of repositories) {
      const state = selectRepoSyncState.get(repo);
      if (state && nowMs - state.last_synced_at < syncIntervalMs) {
        continue;
      }
      const result = await repositorySync.sync(repo);
      applyRepositorySync(repo, result.branch, result.changedFiles, result.deletedFiles, nowMs);
    }
  }

  async function processIndexJobs(): Promise<void> {
    const jobs = selectPendingJobs.all();
    if (jobs.length === 0) {
      return;
    }
    if (!(await llm.healthCheck())) {
      return;
    }
    for (const job of jobs) {
      const chunks = chunkText(job.content);
      if (chunks.length === 0) {
        const nowMs = clock.now().getTime();
        markDocumentIndexed.run(nowMs, job.document_id);
        markJobDone.run(nowMs, job.job_id);
        continue;
      }
      try {
        const embeddings = await llm.embed(chunks.map((c) => c.content));
        saveIndexedChunks(job.job_id, job.document_id, chunks, embeddings, clock.now().getTime());
      } catch {
        // LLM went offline mid-indexing; leave job pending for the next tick.
        return;
      }
    }
  }

  function buildSystemPrompt(askerOpenId: string): string {
    const sections = [SYSTEM_PROMPT];
    const ownerMemories = selectMemoriesByUser.all(settings.ownerOpenId);
    if (ownerMemories.length > 0) {
      sections.push(`Owner's Memories:\n${ownerMemories.map((m) => `- ${m.content}`).join("\n")}`);
    }
    if (askerOpenId !== settings.ownerOpenId) {
      const askerMemories = selectMemoriesByUser.all(askerOpenId);
      if (askerMemories.length > 0) {
        sections.push(
          `Current User's Memories:\n${askerMemories.map((m) => `- ${m.content}`).join("\n")}`,
        );
      }
    }
    return sections.join("\n\n");
  }

  function buildProposalCardItems(proposals: ProposalRow[]) {
    return proposals
      .filter((p) => p.status === "pending")
      .map((p) => {
        const prefix = p.target_memory_id !== null ? `[Update #${p.target_memory_id}]` : "[Add]";
        return {
          id: String(p.id),
          text: `${prefix} (${p.user_open_id}): ${p.content}`,
          actions: [
            {
              label: "Accept",
              action: "accept_memory",
              payload: { proposalId: p.id },
            },
            {
              label: "Edit",
              action: "edit_memory",
              payload: { proposalId: p.id },
            },
            {
              label: "Reject",
              action: "reject_memory",
              payload: { proposalId: p.id },
            },
          ],
        };
      });
  }

  async function submitMemoryProposals(
    items: Array<{
      userOpenId: string;
      content: string;
      source: "remember" | "model" | "idle_extraction";
      targetMemoryId?: number | null;
    }>,
    cardTitle: string,
    cardBody: string,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const nowMs = clock.now().getTime();
    const expiresAt = nowMs + proposalTtlMs;
    const created: ProposalRow[] = [];
    for (const item of items) {
      const res = insertMemoryProposal.run(
        item.userOpenId,
        item.content,
        item.source,
        item.targetMemoryId ?? null,
        nowMs,
        expiresAt,
      );
      const id = Number(res.lastInsertRowid);
      created.push({
        id,
        user_open_id: item.userOpenId,
        content: item.content,
        source: item.source,
        target_memory_id: item.targetMemoryId ?? null,
        status: "pending",
        card_id: null,
        expires_at: expiresAt,
      });
    }

    const cardId = await feishu.sendCard({
      openId: settings.ownerOpenId,
      title: cardTitle,
      body: cardBody,
      items: buildProposalCardItems(created),
    });

    for (const p of created) {
      updateProposalCardId.run(cardId, p.id);
    }
  }

  async function handleRememberCommand(message: InboundMessage, topicId: string): Promise<void> {
    const fact = message.text.trim().slice("/remember".length).trim();
    if (!fact) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: "Usage: /remember <fact>",
      });
      return;
    }

    await submitMemoryProposals(
      [{ userOpenId: message.sender.openId, content: fact, source: "remember" }],
      "Memory Proposal",
      `Requested by ${message.sender.name ?? message.sender.openId} via /remember.`,
    );

    await feishu.replyInTopic({
      chatId: message.chatId,
      topicId,
      text: "Memory proposal submitted for Owner approval.",
    });
  }

  async function handleMemoriesCommand(message: InboundMessage, topicId: string): Promise<void> {
    const isOwner = message.sender.openId === settings.ownerOpenId;
    const arg = message.text.trim().slice("/memories".length).trim();

    const rows = isOwner
      ? arg && arg !== "all"
        ? selectMemoriesByUser.all(arg)
        : selectAllMemories.all()
      : selectMemoriesByUser.all(message.sender.openId);

    if (rows.length === 0) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: "No Memories found.",
      });
      return;
    }

    const lines = rows.map((m) =>
      isOwner ? `- #${m.id} [${m.user_open_id}]: ${m.content}` : `- #${m.id}: ${m.content}`,
    );
    await feishu.replyInTopic({
      chatId: message.chatId,
      topicId,
      text: `Memories:\n${lines.join("\n")}`,
    });
  }

  async function handleForgetCommand(message: InboundMessage, topicId: string): Promise<void> {
    const rawId = message.text.trim().slice("/forget".length).trim().replace(/^#/, "");
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id)) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: "Usage: /forget <memory_id>",
      });
      return;
    }

    const memory = selectMemoryById.get(id);
    const isOwner = message.sender.openId === settings.ownerOpenId;
    if (!memory || (!isOwner && memory.user_open_id !== message.sender.openId)) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: `Memory not found: #${id}`,
      });
      return;
    }

    deleteMemoryById.run(memory.id);
    await feishu.replyInTopic({
      chatId: message.chatId,
      topicId,
      text: `Deleted Memory #${memory.id}: ${memory.content}`,
    });
  }

  async function handleDocsCommand(message: InboundMessage, topicId: string): Promise<void> {
    const isOwner = message.sender.openId === settings.ownerOpenId;
    const docs = isOwner
      ? listOwnerDocs.all()
      : listUserSupplementaryDocs.all(message.sender.openId);
    const label = isOwner ? "Owner Documents" : "Supplementary Documents";

    const parts = message.text.trim().split(/\s+/);
    const subcommand = parts[1]?.toLowerCase();
    const target = parts.slice(2).join(" ").trim();

    if (subcommand === "delete" || subcommand === "rm") {
      if (!target) {
        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: "Usage: /docs delete <filename>",
        });
        return;
      }
      const match = docs.find((d) => d.name === target || String(d.id) === target);
      if (!match) {
        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: `Document not found: ${target}`,
        });
        return;
      }
      deleteDocumentById.run(match.id);
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: `Deleted document: ${match.name}`,
      });
      return;
    }

    if (docs.length === 0) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: `No ${label} found.`,
      });
      return;
    }
    const lines = docs.map((doc) => {
      if (isOwner && doc.kind === "promoted") {
        return `- ${doc.name} (${doc.status}, promoted from ${doc.uploader_open_id})`;
      }
      return `- ${doc.name} (${doc.status})`;
    });
    await feishu.replyInTopic({
      chatId: message.chatId,
      topicId,
      text: `${label}:\n${lines.join("\n")}`,
    });
  }

  async function handleFile(event: InboundFile): Promise<void> {
    const topicId = event.topicId ?? event.messageId;
    if (event.chatType === "group" && !allowedGroupSet.has(event.chatId)) {
      return;
    }
    const isUser = await isAuthorizedUser(event.sender.openId);
    if (!isUser) {
      if (event.chatType === "private") {
        await feishu.replyInTopic({
          chatId: event.chatId,
          topicId,
          text: NO_PERMISSION_REPLY,
        });
      }
      return;
    }

    if (!isSupportedFileName(event.fileName)) {
      await feishu.replyInTopic({
        chatId: event.chatId,
        topicId,
        text: `Unsupported file type: ${event.fileName}`,
      });
      return;
    }

    const buffer = await feishu.downloadFile(event.messageId, event.fileKey);
    const content = extractDocumentText(event.fileName, buffer);
    const isOwner = event.sender.openId === settings.ownerOpenId;
    const docKind = isOwner ? "owner" : "supplementary";
    const docId = upsertAndEnqueueDocument(
      docKind,
      event.fileName,
      event.sender.openId,
      content,
      clock.now().getTime(),
    );

    await feishu.replyInTopic({
      chatId: event.chatId,
      topicId,
      text: `Received ${event.fileName}, pending indexing.`,
    });

    if (!isOwner) {
      const uploaderLabel = event.sender.name
        ? `${event.sender.name} (${event.sender.openId})`
        : event.sender.openId;
      await feishu.sendCard({
        openId: settings.ownerOpenId,
        title: "Promote Supplementary Document?",
        body: `${uploaderLabel} uploaded "${event.fileName}".`,
        items: [
          {
            id: String(docId),
            text: event.fileName,
            actions: [
              {
                label: "Promote to Knowledge Base",
                action: "promote_document",
                payload: { documentId: docId },
              },
              {
                label: "Keep supplementary",
                action: "keep_supplementary",
                payload: { documentId: docId },
              },
            ],
          },
        ],
      });
    }
  }

  async function handleCardAction(event: InboundCardAction): Promise<void> {
    if (event.actorOpenId !== settings.ownerOpenId) {
      return;
    }

    if (event.action === "promote_document" || event.action === "keep_supplementary") {
      const documentId =
        typeof event.payload.documentId === "number" ? event.payload.documentId : null;
      if (documentId === null) {
        return;
      }
      const doc = selectDocumentById.get(documentId);
      if (!doc) {
        return;
      }
      if (event.action === "promote_document") {
        promoteDocumentById.run(clock.now().getTime(), documentId);
        await feishu.updateCard(event.cardId, {
          openId: settings.ownerOpenId,
          title: "Document Promoted",
          body: `"${doc.name}" (uploaded by ${doc.uploader_open_id}) has been promoted to the Knowledge Base.`,
          items: [],
        });
      } else {
        await feishu.updateCard(event.cardId, {
          openId: settings.ownerOpenId,
          title: "Kept as Supplementary Document",
          body: `"${doc.name}" remains a Supplementary Document for ${doc.uploader_open_id}.`,
          items: [],
        });
      }
      return;
    }

    if (
      event.action === "accept_memory" ||
      event.action === "edit_memory" ||
      event.action === "reject_memory"
    ) {
      const nowMs = clock.now().getTime();
      expirePendingProposals.run(nowMs, nowMs);

      const proposalId =
        typeof event.payload.proposalId === "number" ? event.payload.proposalId : null;
      if (proposalId === null) {
        return;
      }
      const proposal = selectProposalById.get(proposalId);
      if (proposal?.status !== "pending") {
        return;
      }

      if (event.action === "reject_memory") {
        resolveProposal.run("rejected", nowMs, proposal.id);
      } else {
        const editedText =
          event.action === "edit_memory" && typeof event.payload.text === "string"
            ? event.payload.text.trim()
            : "";
        const finalContent = editedText || proposal.content;
        if (proposal.target_memory_id !== null) {
          updateMemoryContent.run(finalContent, nowMs, proposal.target_memory_id);
        } else {
          insertMemory.run(proposal.user_open_id, finalContent, nowMs, nowMs);
        }
        resolveProposal.run("accepted", nowMs, proposal.id);
      }

      if (proposal.card_id) {
        const cardProposals = selectProposalsByCardId.all(proposal.card_id);
        const remaining = buildProposalCardItems(cardProposals);
        await feishu.updateCard(proposal.card_id, {
          openId: settings.ownerOpenId,
          title:
            remaining.length > 0 ? "Memory Proposals (in progress)" : "Memory Proposals Reviewed",
          body:
            remaining.length > 0
              ? `${remaining.length} proposal(s) remaining.`
              : "All proposals in this card have been reviewed.",
          items: remaining,
        });
      }
    }
  }

  async function handleMessage(message: InboundMessage): Promise<void> {
    const topicId = message.topicId ?? message.messageId;

    if (message.chatType === "group") {
      const allowedGroup = allowedGroupSet.has(message.chatId);
      if (!message.mentionsBot) {
        if (allowedGroup) {
          recordMessage(topicId, message.chatId, message.chatType, "user", message.text, {
            messageId: message.messageId,
            senderOpenId: message.sender.openId,
            senderName: message.sender.name,
          });
        }
        return;
      }
      const isUser = await isAuthorizedUser(message.sender.openId);
      if (!isUser) {
        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: NO_PERMISSION_REPLY,
        });
        return;
      }
      if (!allowedGroup) {
        return;
      }
    } else {
      const isUser = await isAuthorizedUser(message.sender.openId);
      if (!isUser) {
        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: NO_PERMISSION_REPLY,
        });
        return;
      }
    }

    const trimmed = message.text.trim();
    if (trimmed === "/docs" || trimmed.startsWith("/docs ")) {
      await handleDocsCommand(message, topicId);
      return;
    }
    if (trimmed === "/remember" || trimmed.startsWith("/remember ")) {
      await handleRememberCommand(message, topicId);
      return;
    }
    if (trimmed === "/memories" || trimmed.startsWith("/memories ")) {
      await handleMemoriesCommand(message, topicId);
      return;
    }
    if (trimmed === "/forget" || trimmed.startsWith("/forget ")) {
      await handleForgetCommand(message, topicId);
      return;
    }

    if (!checkAndRecordRateLimit(message.sender.openId)) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: RATE_LIMITED_REPLY,
      });
      return;
    }

    if (!(await llm.healthCheck())) {
      await feishu.replyInTopic({
        chatId: message.chatId,
        topicId,
        text: MODEL_OFFLINE_REPLY,
      });
      return;
    }

    recordMessage(topicId, message.chatId, message.chatType, "user", message.text, {
      messageId: message.messageId,
      senderOpenId: message.sender.openId,
      senderName: message.sender.name,
    });

    await enqueueLlmWork(
      async () => {
        const messages: ChatMessage[] = [
          { role: "system", content: buildSystemPrompt(message.sender.openId) },
          ...formatHistoryMessages(topicId),
        ];
        const tools: ToolDefinition[] = [SEARCH_KB_TOOL, PROPOSE_MEMORY_TOOL, ESCALATE_TOOL];
        const citedSources = new Set<string>();
        let escalated = false;

        let finalText: string | null = null;
        try {
          for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            const response = await llm.chat({
              model: settings.chatModel,
              messages,
              tools,
            });

            if (response.toolCalls.length === 0) {
              finalText = response.text?.trim() ?? null;
              break;
            }

            messages.push({
              role: "assistant",
              content: response.text ?? "",
              toolCalls: response.toolCalls,
            });

            for (const call of response.toolCalls) {
              if (call.name === "search_knowledge_base") {
                const query = typeof call.arguments.query === "string" ? call.arguments.query : "";
                const [queryEmbedding] = await llm.embed([query]);
                const hits = queryEmbedding
                  ? message.chatType === "private" && message.sender.openId !== settings.ownerOpenId
                    ? searchKbWithSupplementaryChunks.all(
                        serializeEmbedding(queryEmbedding),
                        message.sender.openId,
                      )
                    : searchKbChunks.all(serializeEmbedding(queryEmbedding))
                  : [];
                const formattedHits = hits.map((hit) => {
                  const source = formatCitation(hit);
                  citedSources.add(source);
                  return `[Source: ${source}]\n${hit.content}`;
                });
                messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: call.name,
                  content:
                    formattedHits.length > 0
                      ? formattedHits.join("\n\n")
                      : "No relevant documents found in the Knowledge Base.",
                });
              } else if (call.name === "propose_memory") {
                const fact =
                  typeof call.arguments.fact === "string" ? call.arguments.fact.trim() : "";
                if (fact) {
                  await submitMemoryProposals(
                    [
                      {
                        userOpenId: message.sender.openId,
                        content: fact,
                        source: "model",
                      },
                    ],
                    "Memory Proposal",
                    `Proposed during conversation for ${message.sender.name ?? message.sender.openId}.`,
                  );
                }
                messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: call.name,
                  content: fact
                    ? "Memory proposal submitted for Owner approval."
                    : "Ignored empty memory fact.",
                });
              } else if (call.name === "escalate_to_owner") {
                const reason =
                  typeof call.arguments.reason === "string"
                    ? call.arguments.reason
                    : "Unable to answer from Knowledge Base and Memories";
                const link = `https://applink.feishu.cn/client/message/link/open?chatId=${encodeURIComponent(message.chatId)}&messageId=${encodeURIComponent(message.messageId)}`;
                const asker = message.sender.name
                  ? `${message.sender.name} (${message.sender.openId})`
                  : message.sender.openId;
                await feishu.sendPrivateMessage({
                  openId: settings.ownerOpenId,
                  text: [
                    `Escalation from ${asker}:`,
                    `Question: ${message.text}`,
                    `Reason: ${reason}`,
                    `Link: ${link}`,
                  ].join("\n"),
                });
                escalated = true;
                messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: call.name,
                  content:
                    "The Owner has been privately notified. Tell the user you do not know and that the Owner has been notified.",
                });
              } else {
                messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: call.name,
                  content: `Unknown tool: ${call.name}`,
                });
              }
            }
          }
        } catch {
          await feishu.replyInTopic({
            chatId: message.chatId,
            topicId,
            text: MODEL_OFFLINE_REPLY,
          });
          return;
        }

        if (!finalText && escalated) {
          finalText = "I do not know the answer to that. I have privately notified the Owner.";
        }
        if (!finalText) {
          return;
        }

        const sanitizedText =
          message.chatType === "group"
            ? finalText
                .replaceAll(`<at user_id="${settings.ownerOpenId}"></at>`, "the Owner")
                .replaceAll(`@${settings.ownerOpenId}`, "the Owner")
            : finalText;

        const missingCitations = [...citedSources].filter((src) => !sanitizedText.includes(src));
        const outputText =
          missingCitations.length > 0
            ? `${sanitizedText}\n\nSources:\n${missingCitations.map((s) => `- ${s}`).join("\n")}`
            : sanitizedText;

        recordMessage(topicId, message.chatId, message.chatType, "assistant", outputText);

        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: outputText,
        });
      },
      async () => {
        await feishu.replyInTopic({
          chatId: message.chatId,
          topicId,
          text: THINKING_REPLY,
        });
      },
    );
  }

  async function runIdleExtractions(): Promise<void> {
    const nowMs = clock.now().getTime();
    const cutoff = nowMs - extractionIdleMs;
    const idleTopics = selectIdleConversations.all(cutoff);
    if (idleTopics.length === 0) {
      return;
    }
    if (!(await llm.healthCheck())) {
      return;
    }

    for (const topic of idleTopics) {
      const rows = selectConversationMessages.all(topic.topic_id);
      const speakers = new Set<string>();
      for (const row of rows) {
        if (row.role === "user" && row.sender_open_id) {
          speakers.add(row.sender_open_id);
        }
      }
      if (speakers.size === 0) {
        markConversationExtracted.run(topic.last_message_at, topic.topic_id);
        continue;
      }

      const existingBySpeaker = new Map<string, MemoryRow[]>();
      const existingSections: string[] = [];
      for (const openId of speakers) {
        const mems = selectMemoriesByUser.all(openId);
        existingBySpeaker.set(openId, mems);
        if (mems.length > 0) {
          existingSections.push(
            `Speaker ${openId}:\n${mems.map((m) => `  - #${m.id}: ${m.content}`).join("\n")}`,
          );
        } else {
          existingSections.push(`Speaker ${openId}: (none)`);
        }
      }

      const transcript = rows
        .map((row) =>
          row.role === "assistant"
            ? `Assistant: ${row.content}`
            : `${row.sender_name ?? row.sender_open_id ?? "User"} (${row.sender_open_id ?? "unknown"}): ${row.content}`,
        )
        .join("\n");

      let extractionText: string | null = null;
      let failed = false;
      await enqueueLlmWork(async () => {
        try {
          const response = await llm.chat({
            model: settings.chatModel,
            messages: [
              { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  "Existing Memories per speaker:",
                  ...existingSections,
                  "",
                  "Conversation transcript:",
                  transcript,
                ].join("\n"),
              },
            ],
            tools: [],
          });
          extractionText = response.text;
        } catch {
          failed = true;
        }
      });

      if (failed) {
        return;
      }

      const parsed = parseExtractionOutput(extractionText);
      const validProposals: Array<{
        userOpenId: string;
        content: string;
        source: "idle_extraction";
        targetMemoryId: number | null;
      }> = [];

      for (const item of parsed) {
        if (!speakers.has(item.speakerOpenId)) {
          continue;
        }
        const fact = item.fact.trim();
        if (!fact) {
          continue;
        }
        let targetMemoryId: number | null = null;
        if (item.op === "update" && typeof item.memoryId === "number") {
          const speakerMemories = existingBySpeaker.get(item.speakerOpenId) ?? [];
          if (speakerMemories.some((m) => m.id === item.memoryId)) {
            targetMemoryId = item.memoryId;
          }
        }
        validProposals.push({
          userOpenId: item.speakerOpenId,
          content: fact,
          source: "idle_extraction",
          targetMemoryId,
        });
      }

      if (validProposals.length > 0) {
        await submitMemoryProposals(
          validProposals,
          "Idle Extraction Memory Proposals",
          `Extracted ${validProposals.length} candidate Memory proposal(s) from topic ${topic.topic_id}.`,
        );
      }

      markConversationExtracted.run(topic.last_message_at, topic.topic_id);
    }
  }

  return {
    async handle(event) {
      if (event.kind === "file") {
        await handleFile(event);
        return;
      }
      if (event.kind === "card_action") {
        await handleCardAction(event);
        return;
      }
      await handleMessage(event);
    },
    async tick() {
      const nowMs = clock.now().getTime();
      expirePendingProposals.run(nowMs, nowMs);
      await syncRepositories();
      await processIndexJobs();
      await runIdleExtractions();
    },
  };
}

type ExtractedProposal = {
  speakerOpenId: string;
  op: "add" | "update";
  memoryId?: number | null;
  fact: string;
};

function parseExtractionOutput(text: string | null): ExtractedProposal[] {
  if (!text) {
    return [];
  }
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as { proposals?: unknown };
    if (!Array.isArray(parsed.proposals)) {
      return [];
    }
    const result: ExtractedProposal[] = [];
    for (const raw of parsed.proposals) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      if (typeof record.speakerOpenId !== "string" || typeof record.fact !== "string") {
        continue;
      }
      result.push({
        speakerOpenId: record.speakerOpenId,
        op: record.op === "update" ? "update" : "add",
        memoryId: typeof record.memoryId === "number" ? record.memoryId : null,
        fact: record.fact,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function formatCitation(hit: SearchHit): string {
  if (hit.kind === "repository" && hit.repo_name && hit.file_path) {
    const branch = hit.repo_branch ?? "main";
    return `https://github.com/${hit.repo_name}/blob/${branch}/${hit.file_path}#L${hit.start_line}-L${hit.end_line}`;
  }
  return hit.name;
}
