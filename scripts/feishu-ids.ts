// Prints the bot's open_id, then the sender open_id of every message the bot
// receives, so FEISHU_BOT_OPEN_ID and owner.openId can be filled in.
// Usage: npx tsx scripts/feishu-ids.ts   (reads FEISHU_* from .env; Ctrl-C to exit)
import "dotenv/config";
import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";

type BotInfoResponse = {
  code: number;
  msg: string;
  bot?: { open_id?: string; app_name?: string };
};

type MessageEvent = {
  sender: { sender_id?: { open_id?: string } };
  message: { chat_type: string; chat_id: string; content: string };
};

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  throw new Error("Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env");
}
const domain = process.env.FEISHU_DOMAIN === "lark" ? Domain.Lark : Domain.Feishu;

const client = new Client({ appId, appSecret, domain });
const info = await client.request<BotInfoResponse>({
  method: "GET",
  url: "/open-apis/bot/v3/info",
});
if (info.code !== 0) {
  throw new Error(`bot info failed with ${info.code}: ${info.msg}`);
}
console.log(`FEISHU_BOT_OPEN_ID=${info.bot?.open_id}   (${info.bot?.app_name})`);

const dispatcher = new EventDispatcher({}).register({
  "im.message.receive_v1": async (event: MessageEvent) => {
    const chat = event.message.chat_type === "p2p" ? "private" : `group ${event.message.chat_id}`;
    console.log(
      `sender open_id=${event.sender.sender_id?.open_id}  [${chat}]  ${event.message.content}`,
    );
  },
});

const wsClient = new WSClient({ appId, appSecret, domain, loggerLevel: LoggerLevel.warn });
await wsClient.start({ eventDispatcher: dispatcher });
console.log("Listening. Send the bot a private message; your open_id is the sender open_id.");
