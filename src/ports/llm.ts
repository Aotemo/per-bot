export type ChatMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
};

export type ChatResponse = {
  text: string | null;
  toolCalls: ToolCall[];
};

export type LlmPort = {
  chat(request: ChatRequest): Promise<ChatResponse>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
};
