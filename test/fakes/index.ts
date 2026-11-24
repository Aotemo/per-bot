import type { Clock } from "../../src/ports/clock";
import type {
  FeishuPort,
  GroupMember,
  InteractiveCard,
  PrivateMessage,
  ReplyInTopic,
} from "../../src/ports/feishu";
import type {
  ChatRequest,
  ChatResponse,
  LlmPort,
  ToolCall,
  ToolDefinition,
} from "../../src/ports/llm";
import type { RepositorySyncPort, SyncedFile } from "../../src/ports/repository-sync";

export type RecordedCard = InteractiveCard & {
  cardId: string;
};

export type FakeFeishu = FeishuPort & {
  replies: ReplyInTopic[];
  privateMessages: PrivateMessage[];
  cards: RecordedCard[];
  groupMembers: Map<string, GroupMember[]>;
  groupMemberLookups: string[];
  files: Map<string, Buffer>;
};

/** Group members may be given as bare open_ids (no display name) or full members. */
export function createFakeFeishu(
  initialGroups: Record<string, Array<string | GroupMember>> = {},
): FakeFeishu {
  const replies: ReplyInTopic[] = [];
  const privateMessages: PrivateMessage[] = [];
  const cards: RecordedCard[] = [];
  const groupMembers = new Map<string, GroupMember[]>(
    Object.entries(initialGroups).map(([chatId, members]) => [
      chatId,
      members.map((member) =>
        typeof member === "string" ? { openId: member, name: null } : member,
      ),
    ]),
  );
  const groupMemberLookups: string[] = [];
  const files = new Map<string, Buffer>();
  let nextCardNumber = 1;
  return {
    replies,
    privateMessages,
    cards,
    groupMembers,
    groupMemberLookups,
    files,
    async replyInTopic(reply) {
      replies.push(reply);
    },
    async sendPrivateMessage(message) {
      privateMessages.push(message);
    },
    async sendCard(card) {
      const cardId = `card_${nextCardNumber}`;
      nextCardNumber += 1;
      cards.push({ ...card, cardId });
      return cardId;
    },
    async updateCard(cardId, card) {
      const index = cards.findIndex((c) => c.cardId === cardId);
      if (index >= 0) {
        cards[index] = { ...card, cardId };
      }
    },
    async listGroupMembers(chatId) {
      groupMemberLookups.push(chatId);
      return groupMembers.get(chatId) ?? [];
    },
    async listBotGroups() {
      return [...groupMembers.keys()];
    },
    async downloadFile(_messageId, fileKey) {
      const content = files.get(fileKey);
      if (!content) {
        throw new Error(`file not found: ${fileKey}`);
      }
      return content;
    },
  };
}

export type ScriptedReply = { text: string } | { toolCall: ToolCall };

export type FakeLlm = LlmPort & {
  requests: ChatRequest[];
  embedCalls: string[][];
  offline: boolean;
  /** Embedding any text containing this marker fails while the model stays healthy. */
  failEmbedMarker: string | null;
  inFlight: number;
  maxInFlight: number;
  setOffline(offline: boolean): void;
  pauseNextChat(): () => void;
};

export function createFakeLlm(script: ScriptedReply[] = []): FakeLlm {
  const requests: ChatRequest[] = [];
  const embedCalls: string[][] = [];
  const gates: Array<Promise<void>> = [];
  const fake: FakeLlm = {
    requests,
    embedCalls,
    offline: false,
    failEmbedMarker: null,
    inFlight: 0,
    maxInFlight: 0,
    setOffline(offline) {
      fake.offline = offline;
    },
    pauseNextChat() {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.push(gate);
      return () => {
        release?.();
      };
    },
    async chat(request) {
      fake.inFlight += 1;
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
      requests.push(request);
      try {
        const gate = gates.shift();
        if (gate) {
          await gate;
        }
        if (fake.offline) {
          throw new Error("model offline");
        }
        const next = script.shift();
        if (!next) {
          throw new Error("no scripted LLM reply left");
        }
        return "text" in next
          ? ({ text: next.text, toolCalls: [] } satisfies ChatResponse)
          : ({ text: null, toolCalls: [next.toolCall] } satisfies ChatResponse);
      } finally {
        fake.inFlight -= 1;
      }
    },
    async embed(texts) {
      if (fake.offline) {
        throw new Error("model offline");
      }
      const marker = fake.failEmbedMarker;
      if (marker && texts.some((text) => text.includes(marker))) {
        throw new Error("embedding failed");
      }
      embedCalls.push(texts);
      return texts.map((text) => deterministicEmbedding(text));
    },
    async healthCheck() {
      return !fake.offline;
    },
  };
  return fake;
}

function deterministicEmbedding(text: string): number[] {
  let seed = 0;
  for (const char of text) {
    seed = (seed * 31 + (char.codePointAt(0) ?? 0)) % 1000;
  }
  return [seed / 1000, text.length / 100];
}

export type ToolCalling = (tools: ToolDefinition[]) => ToolCall;

export type FakeRepositorySync = RepositorySyncPort & {
  synced: string[];
  branch: string;
  changedFiles: SyncedFile[];
  deletedFiles: string[];
};

export function createFakeRepositorySync(): FakeRepositorySync {
  const fake: FakeRepositorySync = {
    synced: [],
    branch: "main",
    changedFiles: [],
    deletedFiles: [],
    async sync(repository) {
      fake.synced.push(repository);
      return {
        branch: fake.branch,
        changedFiles: fake.changedFiles,
        deletedFiles: fake.deletedFiles,
      };
    },
  };
  return fake;
}

export type ManualClock = Clock & {
  advance(milliseconds: number): void;
};

export function createManualClock(start: Date): ManualClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}
