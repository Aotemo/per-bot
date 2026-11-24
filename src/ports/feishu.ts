/** An outbound Feishu action: a text reply inside a topic. */
export type ReplyInTopic = {
  chatId: string;
  topicId: string;
  text: string;
};

export type PrivateMessage = {
  openId: string;
  text: string;
};

export type CardActionButton = {
  label: string;
  action: string;
  payload: Record<string, unknown>;
};

export type CardItem = {
  id: string;
  text: string;
  actions: CardActionButton[];
};

export type InteractiveCard = {
  openId: string;
  title: string;
  body: string;
  items: CardItem[];
};

export type FeishuPort = {
  replyInTopic(reply: ReplyInTopic): Promise<void>;
  sendPrivateMessage(message: PrivateMessage): Promise<void>;
  sendCard(card: InteractiveCard): Promise<string>;
  updateCard(cardId: string, card: InteractiveCard): Promise<void>;
  listGroupMembers(chatId: string): Promise<string[]>;
  downloadFile(messageId: string, fileKey: string): Promise<Buffer>;
};
