export type ChatType = "private" | "group";

export type Sender = {
  openId: string;
  name: string | null;
};

export type InboundMessage = {
  kind: "message";
  chatType: ChatType;
  chatId: string;
  /** Root message of the topic the message belongs to; `null` outside any topic. */
  topicId: string | null;
  messageId: string;
  sender: Sender;
  mentionsBot: boolean;
  text: string;
};

export type InboundFile = {
  kind: "file";
  chatType: ChatType;
  chatId: string;
  topicId: string | null;
  messageId: string;
  sender: Sender;
  fileKey: string;
  fileName: string;
};

export type InboundCardAction = {
  kind: "card_action";
  cardId: string;
  action: string;
  payload: Record<string, unknown>;
  actorOpenId: string;
};

export type InboundEvent = InboundMessage | InboundFile | InboundCardAction;
