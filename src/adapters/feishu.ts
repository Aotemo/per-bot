import { Client, Domain, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { InboundCardAction, InboundEvent } from "../domain/inbound";
import type { FeishuPort, GroupMember, InteractiveCard } from "../ports/feishu";

export type FeishuAdapterOptions = {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
};

export type FeishuAdapter = {
  port: FeishuPort;
  dispatcher: EventDispatcher;
  wsClient: WSClient;
};

/** Feishu client in long-connection mode: no public URL or webhook needed. */
export function createFeishuAdapter(options: FeishuAdapterOptions): FeishuAdapter {
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain === "lark" ? Domain.Lark : Domain.Feishu,
  });

  return {
    port: {
      async replyInTopic(reply) {
        const result = await client.im.message.reply({
          path: { message_id: reply.topicId },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text: reply.text }),
            reply_in_thread: true,
          },
        });
        if (result.code !== 0) {
          throw new Error(`Feishu reply failed with ${result.code}: ${result.msg}`);
        }
      },
      async sendPrivateMessage(message) {
        const result = await client.im.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: message.openId,
            msg_type: "text",
            content: JSON.stringify({ text: message.text }),
          },
        });
        if (result.code !== 0) {
          throw new Error(`Feishu sendPrivateMessage failed with ${result.code}: ${result.msg}`);
        }
      },
      async sendCard(card) {
        const result = await client.im.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: card.openId,
            msg_type: "interactive",
            content: JSON.stringify(buildFeishuCardPayload(card)),
          },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`Feishu sendCard failed with ${result.code}: ${result.msg}`);
        }
        return result.data.message_id;
      },
      async updateCard(cardId, card) {
        const result = await client.im.message.patch({
          path: { message_id: cardId },
          data: {
            content: JSON.stringify(buildFeishuCardPayload(card)),
          },
        });
        if (result.code !== 0) {
          throw new Error(`Feishu updateCard failed with ${result.code}: ${result.msg}`);
        }
      },
      async listGroupMembers(chatId) {
        const members: GroupMember[] = [];
        let pageToken: string | undefined;
        do {
          const result = await client.im.chatMembers.get({
            path: { chat_id: chatId },
            params: {
              member_id_type: "open_id",
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          if (result.code !== 0) {
            throw new Error(`Feishu listGroupMembers failed with ${result.code}: ${result.msg}`);
          }
          for (const item of result.data?.items ?? []) {
            if (item.member_id) {
              members.push({ openId: item.member_id, name: item.name ?? null });
            }
          }
          pageToken = result.data?.has_more ? result.data.page_token : undefined;
        } while (pageToken);
        return members;
      },
      async listBotGroups() {
        const chatIds: string[] = [];
        let pageToken: string | undefined;
        do {
          const result = await client.im.chat.list({
            params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
          });
          if (result.code !== 0) {
            throw new Error(`Feishu listBotGroups failed with ${result.code}: ${result.msg}`);
          }
          for (const item of result.data?.items ?? []) {
            if (item.chat_id) {
              chatIds.push(item.chat_id);
            }
          }
          pageToken = result.data?.has_more ? result.data.page_token : undefined;
        } while (pageToken);
        return chatIds;
      },
      async downloadFile(messageId, fileKey) {
        const response = await client.im.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: "file" },
        });
        const stream = response.getReadableStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      },
    },
    dispatcher: new EventDispatcher({}),
    wsClient: new WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.domain === "lark" ? Domain.Lark : Domain.Feishu,
    }),
  };
}

type RawMessageEvent = {
  sender: {
    sender_type: string;
    sender_id?: { open_id?: string };
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    root_id?: string;
    content: string;
    mentions?: Array<{ key: string; name: string; id: { open_id?: string } }>;
  };
};

/** Normalizes a Feishu `im.message.receive_v1` event; returns null for events to ignore. */
export function normalizeMessageEvent(
  event: RawMessageEvent,
  botOpenId?: string,
): InboundEvent | null {
  if (event.sender.sender_type !== "user") {
    return null;
  }

  const openId = event.sender.sender_id?.open_id;
  if (!openId) {
    return null;
  }

  const chatType = event.message.chat_type === "p2p" ? "private" : "group";

  if (event.message.message_type === "file") {
    const parsed = JSON.parse(event.message.content) as {
      file_key?: string;
      file_name?: string;
    };
    if (!parsed.file_key || !parsed.file_name) {
      return null;
    }
    return {
      kind: "file",
      chatType,
      chatId: event.message.chat_id,
      topicId: event.message.root_id ?? null,
      messageId: event.message.message_id,
      sender: { openId, name: null },
      fileKey: parsed.file_key,
      fileName: parsed.file_name,
    };
  }

  if (event.message.message_type !== "text") {
    return null;
  }

  const mentions = event.message.mentions ?? [];
  const mentionsBot = botOpenId
    ? mentions.some((m) => m.id.open_id === botOpenId)
    : mentions.length > 0;

  return {
    kind: "message",
    chatType,
    chatId: event.message.chat_id,
    topicId: event.message.root_id ?? null,
    messageId: event.message.message_id,
    sender: { openId, name: null },
    mentionsBot,
    text: extractText(event.message.content, mentions),
  };
}

function extractText(content: string, mentions: Array<{ key: string }>): string {
  const parsed = JSON.parse(content) as { text?: string };
  let text = parsed.text ?? "";
  for (const mention of mentions) {
    text = text.replaceAll(`@${mention.key}`, "");
  }
  return text.trim();
}

function buildFeishuCardPayload(card: InteractiveCard): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: { tag: "lark_md", content: card.body },
    },
  ];
  for (const item of card.items) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: item.text },
    });
    const editAction = item.actions.find((btn) => btn.action === "edit_memory");
    const nonEditActions = item.actions.filter((btn) => btn.action !== "edit_memory");
    if (nonEditActions.length > 0) {
      elements.push({
        tag: "action",
        actions: nonEditActions.map((btn) => ({
          tag: "button",
          text: { tag: "plain_text", content: btn.label },
          type: "default",
          value: { action: btn.action, ...btn.payload },
        })),
      });
    }
    if (editAction) {
      elements.push({
        tag: "form",
        name: `edit_form_${item.id}`,
        elements: [
          {
            tag: "input",
            name: "text",
            placeholder: { tag: "plain_text", content: "Edit memory text..." },
          },
          {
            tag: "button",
            name: `submit_${item.id}`,
            text: { tag: "plain_text", content: editAction.label },
            type: "default",
            action_type: "form_submit",
            value: { action: editAction.action, ...editAction.payload },
          },
        ],
      });
    }
  }
  return {
    // update_multi is required for im.message.patch to update a sent card.
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: card.title },
    },
    elements,
  };
}

export type RawCardActionEvent = {
  operator?: { open_id?: string };
  context?: { open_message_id?: string };
  action?: {
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
};

export function normalizeCardActionEvent(event: RawCardActionEvent): InboundCardAction | null {
  const actorOpenId = event.operator?.open_id;
  const cardId = event.context?.open_message_id;
  const value = event.action?.value;
  const action = typeof value?.action === "string" ? value.action : null;
  if (!actorOpenId || !cardId || !action || !value) {
    return null;
  }
  return {
    kind: "card_action",
    cardId,
    action,
    payload: { ...value, ...(event.action?.form_value ?? {}) },
    actorOpenId,
  };
}
