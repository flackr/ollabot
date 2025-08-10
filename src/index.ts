import * as fs from "node:fs";
import { AutojoinRoomsMixin, MatrixAuth, MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from "matrix-bot-sdk";
import { ChatRequest, Ollama } from 'ollama';
import { z } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

const COUNT = 30;
// How long to keep the model alive.
const KEEP_ALIVE = 30 * 60; // 30 minutes
type ChatMessage = {
  from: string;
  message: string;
};
type Message = {
  role: "user" | "system" | "assistant";
  content: string;
  images?: Uint8Array[] | string[];
};

type ConfigFile = {
  bots: BotConfig[];
};

type TypingResponse = {
  aborted: boolean;
};

type RoomData = {
  ollama: Ollama;
  messages: Message[];
  model: string;
  typing: TypingResponse | null;
  busy: boolean;
  resolveWaiting?: (run: boolean) => void;
  summary: string;
  respond: boolean;
};

type RegexAlias = {
  regex: RegExp;
  alias: string;
}

type RunningBot = {
  config: BotConfig;
  client: MatrixClient;
  rooms: {[id: string]: RoomData};
}

type BotConfig = {
  model: string;
  homeserverUrl: string;
  userId: string;
  accessToken?: string;
  username: string;
  password: string;
  reactions: boolean;
  respond: "sometimes" | "always" | "mentioned";
  aliases: {[id:string]: string};
  messageAliases?: {[id:string]: string};
  systemPrompts: string[];
};

const REACTIONS: {[id: string]: string} = {
  "laugh": "😂",
  "love": "❤️",
  "like": "👍",
  "dislike": "👎",
  "celebrate": "🎉",
  "thinking": "🤔",
  "happy": "😊",
  "watching": "👀",
  "sleepy": "😴",
  "sad": "😢",
};

const SummaryMessageFormat = z.object({
  summary: z.string(),
});
type SummaryMessageType = z.infer<typeof SummaryMessageFormat>;

async function chat<Type>(ollama: Ollama, typing: TypingResponse, request: ChatRequest): Promise<Type | null> {
  if (typing.aborted) {
    return null;
  }
  let response = await ollama.chat({...request, stream: true, keep_alive: KEEP_ALIVE});
  let responseData = "";
  try {
    for await (const chunk of response) {
      if (typing.aborted) {
        response.abort();
        return null;
      }
      responseData += chunk.message.content;
    }
    if (typing.aborted) {
      return null;
    }
    console.log(responseData);
    return JSON.parse(responseData) as Type;
  } catch (error: any) {
    if (error.name === "AbortError") {
    } else {
      console.error(error);
    }
  }
  return null;
}

async function main(): Promise<void> {
  let configData: ConfigFile = JSON.parse(fs.readFileSync("bots.json", {encoding: 'utf8'}));
  const bots: {[id: string]: RunningBot} = {};
  for (let botConfig of configData.bots) {
    if (bots[botConfig.userId])
      throw Error(`Multiple bots with userId ${botConfig.userId}`);
    const DIR = `.bot/${botConfig.userId}`
    const storageProvider = new SimpleFsStorageProvider(`${DIR}/bot.json`); // or any other IStorageProvider
    const cryptoProvider = new RustSdkCryptoStorageProvider(`${DIR}/crypto`);
    /*
    TODO: Support login or registration, e.g.
    Registration:
    const auth = new MatrixAuth(homeserverUrl);
    const client = await auth.passwordRegister("username", "password");

    Login:
    const auth = new MatrixAuth(homeserverUrl);
    const client = await auth.passwordLogin(username, password);

    Then, save the access token:
    console.log("Copy this access token to your bot's config: ", client.accessToken);
    */
    if (!botConfig.accessToken) {
      const auth = new MatrixAuth(botConfig.homeserverUrl);
      const client = await auth.passwordRegister(botConfig.username, botConfig.password);
      botConfig.accessToken = client.accessToken;
      fs.writeFileSync("bots.json", JSON.stringify(configData, null, 2), {encoding: 'utf8'});
    }
    let messageAliases: RegexAlias[] = [];
    if (botConfig.messageAliases) {
      for (let regexstr in botConfig.messageAliases) {
        messageAliases.push({
          regex: new RegExp(regexstr),
          alias: botConfig.messageAliases[regexstr]
        });
      }
    }
    const client = new MatrixClient(botConfig.homeserverUrl, botConfig.accessToken, storageProvider, cryptoProvider);
    const bot: RunningBot = bots[botConfig.userId] = {
      config: botConfig,
      client,
      rooms: {}
    };
    const JSONMessageFormat = z.object({
      respond: z.enum(["yes", "no"]),
      feeling: z.enum(["none", ...Object.keys(REACTIONS)]),
      from: z.literal(botConfig.username),
      message: z.optional(z.string()),
    });
    const JSONMandatoryMessageFormat = z.object({
      respond: z.enum(["yes", "no"]),
      feeling: z.enum(["none", ...Object.keys(REACTIONS)]),
      from: z.literal(botConfig.username),
      message: z.string(),
    });
    const JSONNoMessageFormat = z.object({
      respond: z.enum(["yes", "no"]),
      feeling: z.enum(["none", ...Object.keys(REACTIONS)]),
      from: z.literal(botConfig.username),
    });
    type MessageResponse = z.infer<typeof JSONMessageFormat>;

    AutojoinRoomsMixin.setupOnClient(client);
    client.on("room.message", async (roomId: string, event: any) => {
      // Don't handle unhelpful events (ones that aren't text messages, are redacted, or sent by us)
      if (event['content']?.['msgtype'] !== 'm.text' && event['content']?.['msgtype'] !== 'm.emote') return;
      if (event['sender'] === await client.getUserId()) return;
      let alias = event['sender'].match(/^@([^:]+):/)[1];
      alias = botConfig.aliases[event['sender']] || alias;
      if (!alias) return;
      const room: RoomData = bot.rooms[roomId] = bot.rooms[roomId] || {
        model: botConfig.model,
        messages: [],
        ollama: new Ollama({ host: 'http://localhost:11434' }),
        response: null,
        typing: null,
        busy: false,
        resolveWaiting: undefined,
        summary: "",
        respond: false,
      };
      const message: ChatMessage = {
        from: alias,
        message: event.content.body.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      }
      for (let aliasregex of messageAliases) {
        let match = message.message.match(aliasregex.regex);
        if (match && match[1]) {
          message.message = match[1];
          message.from = aliasregex.alias;
          break;
        }
      }
      if (event.content.msgtype == 'm.emote') {
        message.message = `*${message.from} ${message.message}`;
      }
      room.messages.push({
        role: "user",
        content: JSON.stringify(message)
      });
      const summaryMessage = {role: "system", "content": "The summary of the conversation so far is: " + JSON.stringify({summary: room.summary}) };
      if (room.busy) {
        if (room.resolveWaiting) {
          room.resolveWaiting(false);
        }
        const shouldRun = await new Promise((resolve) => {
          room.resolveWaiting = resolve;
        });
        if (!shouldRun)
          return;
      }
      if (room.messages.length > COUNT) {
        room.busy = true;
        // TODO: Summarize at points of gaps in the conversation as these
        // represent times when we're more likely to have complete context.
        let toSummarize = room.messages.splice(0, Math.max(Math.floor(COUNT / 2), room.messages.length - COUNT));
        let summary = await chat<SummaryMessageType>(room.ollama, {aborted: false}, {
          model: room.model,
          messages: [
            {role: "system", "content": "Given a summary of the conversation so far and the conversation that has happened since you must concisely update the summary. The summary MUST be no more than 200 words.\nExample:\n{\"summary\":\"sally was asking about good computers to buy. george recommended she look into thinkpads. bob shared his elaborate breakfast of waffles and pancakes.\"}"},
            summaryMessage,
          ].concat(toSummarize).concat([
            {role: "system", "content": "Write an updated summary for the conversation."}
          ]),
          format: zodToJsonSchema(SummaryMessageFormat)
        });
        if (summary) {
          console.log("Summary: " + summary.summary);
          room.summary = summary.summary;
        }
        room.busy = false;
        if (room.resolveWaiting) {
          room.resolveWaiting(true);
          room.resolveWaiting = undefined;
          return;
        }
      }
      if (room.typing && !room.typing.aborted) {
        room.typing.aborted = true;
        room.ollama.abort();
      }
      let typing = { aborted: false };
      room.typing = typing;
      const mentioned = message.message.match(new RegExp(`\\b${botConfig.username}\\b`));
      if (botConfig.respond == "always" || mentioned) { room.respond = true; }

      client.sendReadReceipt(roomId, event.event_id);

      // If the bot is configured to respond only when mentioned, and it wasn't mentioned, skip processing.
      if (botConfig.respond == "mentioned" && !room.respond && !botConfig.reactions)
        return;

      let promptMessages = botConfig.systemPrompts.map(prompt => { return {role: "system", "content": prompt};}).concat(summaryMessage).concat(room.messages);
      promptMessages.push({role: "system", "content": `Respond in JSON whether ${botConfig.username} responds (yes, no) and how ${botConfig.username} is feeling (none, ${Object.keys(REACTIONS).join(", ")}), and optionally the response message.`});

      const format = room.respond ? JSONMandatoryMessageFormat : (botConfig.respond == "sometimes" ? JSONMessageFormat : JSONNoMessageFormat);
      if (room.respond) {
        await client.setTyping(roomId, true, 120000);
      }
      let response = await chat<MessageResponse>(room.ollama, typing, {
        model: room.model,
        messages: promptMessages,
        format: zodToJsonSchema(format)
      });
      if (!response) return;

      // Send a reaction if the bot reacted.
      if (botConfig.reactions && response.feeling != "none") {
        client.sendEvent(roomId, "m.reaction", {
          "m.relates_to": { rel_type: "m.annotation", key: REACTIONS[response.feeling], event_id: event.event_id}
        });
      }
      // TODO: Stream the response JSON and set typing as soon as we know there is a message.
      // await client.setTyping(roomId, true, 100000);
      if (!response.message) return;
      room.typing = null;
      room.messages.push({
        role: "assistant",
        content: JSON.stringify(response)
      });
      await client.sendText(roomId, response.message);
      client.setTyping(roomId, false);
      room.respond = false;
    });
    client.start().then(() => console.log(`Started ${botConfig.userId}`));
  }
}

main();
