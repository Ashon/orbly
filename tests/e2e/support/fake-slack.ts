import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { REQUIRED_BOT_SCOPES } from "../../../src/messengers/slack/check.js";

/**
 * A Slack workspace on this computer for end-to-end tests: the Web API the bot and the hub call (SLACK_API_URL),
 * Socket Mode (apps.connections.open hands out its WebSocket), file downloads and uploads, and the channels, users
 * and threads behind them. Mentions are sent the way Slack sends them, as events_api envelopes the client must ack.
 */

export interface FakeUser {
  id: string;
  name: string;
}

export interface FakeChannel {
  id: string;
  name: string;
  isPublic: boolean;
}

export interface FakeFile {
  id: string;
  name: string;
  mimetype: string;
  filetype?: string;
  content: Buffer;
  /** denied: the download returns Slack's login page, as without files:read. summary: the event carries only the id. */
  access?: "ok" | "denied" | "summary";
}

export interface FakeMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  files?: Record<string, unknown>[];
  /** Earlier texts, for messages the bot edited (chat.update) */
  edits: string[];
}

export interface ApiCall {
  method: string;
  args: Record<string, string>;
  token?: string;
}

export interface Ephemeral {
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
}

export interface UploadRecord {
  channel: string;
  thread_ts?: string;
  files: { title?: string; filename: string; size: number }[];
}

const BOT_ID = "B0ORBLY";
const APP_ID = "A0E2E";

export class FakeSlack {
  readonly botToken = "xoxb-e2e-0000-bot";
  readonly appToken = "xapp-1-A0E2E-0000-app";
  readonly botUserId = "U0ORBLY";
  readonly team = { id: "T0E2E", name: "e2e" };
  readonly calls: ApiCall[] = [];
  readonly ephemerals: Ephemeral[] = [];
  readonly uploads: UploadRecord[] = [];
  /** Makes auth.test fail with this error, as for a revoked token */
  authError?: string;

  private readonly users = new Map<string, FakeUser>();
  private readonly channels = new Map<string, FakeChannel>();
  private readonly messages = new Map<string, FakeMessage[]>();
  private readonly files = new Map<string, FakeFile>();
  private readonly pendingUploads = new Map<string, { filename: string; size: number }>();
  private readonly acks = new Map<string, () => void>();
  private readonly sockets = new Set<WebSocket>();
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private clock = 1_700_000_000;
  private port = 0;
  private pinger?: NodeJS.Timeout;

  constructor() {
    this.addUser({ id: this.botUserId, name: "orbly" });
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    });
    this.server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/socket")) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** SLACK_API_URL for the bot and the hub */
  get apiUrl(): string {
    return `${this.url}/api/`;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    // Slack pings its Socket Mode clients; without pings they reconnect after SOCKET_SERVER_PING_TIMEOUT_MS.
    this.pinger = setInterval(() => this.sockets.forEach((ws) => ws.ping()), 5_000);
    return this;
  }

  async stop(): Promise<void> {
    clearInterval(this.pinger);
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  addUser(user: FakeUser): FakeUser {
    this.users.set(user.id, user);
    return user;
  }

  addChannel(channel: FakeChannel): FakeChannel {
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    return channel;
  }

  addFile(file: FakeFile): FakeFile {
    this.files.set(file.id, file);
    return file;
  }

  /** A message someone posted earlier (conversation context) */
  post(
    channel: string,
    message: { user: string; text: string; thread_ts?: string }
  ): string {
    return this.append(channel, { ...message, edits: [] }).ts;
  }

  /** Open Socket Mode connections (the bot's own app, or the hub) */
  get connections(): number {
    return [...this.sockets].filter((ws) => ws.readyState === ws.OPEN).length;
  }

  /**
   * Posts a message that mentions the bot and delivers the app_mention event over Socket Mode. Resolves once the
   * client acks it, with the message's ts.
   */
  async mention(input: {
    channel: string;
    user: string;
    text: string;
    thread_ts?: string;
    files?: string[];
    /** Delivers an event already sent once, as Slack does when an ack is late */
    redeliver?: { ts: string };
  }): Promise<string> {
    const ws = [...this.sockets].find((socket) => socket.readyState === socket.OPEN);
    if (!ws) throw new Error("No Socket Mode connection to deliver the mention to");
    const files = (input.files ?? []).map((id) => this.eventFile(this.files.get(id)!));
    const ts =
      input.redeliver?.ts ??
      this.append(input.channel, {
        user: input.user,
        text: input.text,
        thread_ts: input.thread_ts,
        files: files.length > 0 ? files : undefined,
        edits: [],
      }).ts;
    const envelopeId = randomBytes(8).toString("hex");
    const acked = new Promise<void>((resolve) => this.acks.set(envelopeId, resolve));
    ws.send(
      JSON.stringify({
        envelope_id: envelopeId,
        type: "events_api",
        accepts_response_payload: false,
        retry_attempt: input.redeliver ? 1 : 0,
        retry_reason: input.redeliver ? "timeout" : "",
        payload: {
          token: "verification",
          team_id: this.team.id,
          api_app_id: APP_ID,
          type: "event_callback",
          event_id: `Ev${envelopeId}`,
          event_time: Math.floor(Date.now() / 1000),
          authorizations: [
            { team_id: this.team.id, user_id: this.botUserId, is_bot: true },
          ],
          event: {
            type: "app_mention",
            user: input.user,
            text: input.text,
            ts,
            event_ts: ts,
            channel: input.channel,
            team: this.team.id,
            ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
            ...(files.length > 0 ? { files } : {}),
          },
        },
      })
    );
    await acked;
    return ts;
  }

  /** A thread's messages, the root first */
  thread(channel: string, ts: string): FakeMessage[] {
    return (this.messages.get(channel) ?? []).filter(
      (m) => m.ts === ts || m.thread_ts === ts
    );
  }

  /** The bot's messages in a thread */
  replies(channel: string, ts: string): FakeMessage[] {
    return this.thread(channel, ts).filter((m) => m.user === this.botUserId);
  }

  callsTo(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private append(channel: string, message: Omit<FakeMessage, "ts">): FakeMessage {
    this.clock += 1;
    const full = {
      ...message,
      ts: `${this.clock}.${String(this.clock % 1e6).padStart(6, "0")}`,
    };
    const list = this.messages.get(channel);
    if (!list) throw new Error(`Unknown channel ${channel}`);
    list.push(full);
    return full;
  }

  private connect(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { envelope_id?: string };
      if (message.envelope_id) this.acks.get(message.envelope_id)?.();
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        num_connections: this.sockets.size,
        debug_info: { host: "fake-slack" },
        connection_info: { app_id: APP_ID },
      })
    );
  }

  /** A file as an event carries it: in full, or as a summary that needs files.info */
  private eventFile(file: FakeFile): Record<string, unknown> {
    if (file.access === "summary") return { id: file.id, file_access: "check_file_info" };
    return this.fileInfo(file);
  }

  private fileInfo(file: FakeFile): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      title: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype ?? file.name.split(".").pop(),
      size: file.content.length,
      url_private_download: `${this.url}/files-pri/${this.team.id}-${file.id}/download/${encodeURIComponent(file.name)}`,
    };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const body = await readBody(req);
    if (url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      const { token: bodyToken, ...args } = parseArgs(
        body,
        req.headers["content-type"] ?? ""
      );
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? bodyToken;
      this.calls.push({ method, args, token });
      const { json, headers } = this.api(method, args, token);
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
      return;
    }
    const download = /^\/files-pri\/[A-Z0-9]+-([A-Z0-9]+)\/download\//.exec(url.pathname);
    if (download) {
      const file = this.files.get(download[1]!);
      const authorized = req.headers.authorization === `Bearer ${this.botToken}`;
      if (!file || !authorized || file.access === "denied") {
        // Slack answers a download without access with its login page, and 200.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>Sign in to Slack</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": file.mimetype });
      res.end(file.content);
      return;
    }
    const upload = /^\/upload\/([^/]+)$/.exec(url.pathname);
    if (upload && this.pendingUploads.has(upload[1]!)) {
      this.pendingUploads.get(upload[1]!)!.size = body.length;
      res.writeHead(200).end("OK");
      return;
    }
    res.writeHead(404).end("not found");
  }

  private api(
    method: string,
    args: Record<string, string>,
    token: string | undefined
  ): { json: Record<string, unknown>; headers?: Record<string, string> } {
    const ok = (json: Record<string, unknown> = {}) => ({ json: { ok: true, ...json } });
    const fail = (error: string) => ({ json: { ok: false, error } });
    if (method === "apps.connections.open") {
      if (token !== this.appToken) return fail("invalid_auth");
      return ok({
        url: `ws://127.0.0.1:${this.port}/socket?ticket=${randomBytes(4).toString("hex")}`,
      });
    }
    if (token !== this.botToken) return fail("invalid_auth");
    switch (method) {
      case "auth.test":
        if (this.authError) return fail(this.authError);
        return {
          json: {
            ok: true,
            url: `${this.url}/`,
            team: this.team.name,
            team_id: this.team.id,
            user: "orbly",
            user_id: this.botUserId,
            bot_id: BOT_ID,
          },
          headers: { "x-oauth-scopes": REQUIRED_BOT_SCOPES.join(",") },
        };
      case "bots.info":
        return ok({ bot: { id: BOT_ID, app_id: APP_ID, user_id: this.botUserId } });
      case "users.info": {
        const user = this.users.get(args.user ?? "");
        if (!user) return fail("user_not_found");
        return ok({
          user: { id: user.id, name: user.name, profile: { display_name: user.name } },
        });
      }
      case "conversations.info": {
        const channel = this.channels.get(args.channel ?? "");
        if (!channel) return fail("channel_not_found");
        return ok({
          channel: {
            id: channel.id,
            name: channel.name,
            is_channel: true,
            is_private: !channel.isPublic,
          },
        });
      }
      case "conversations.replies":
        return ok({ messages: this.thread(args.channel ?? "", args.ts ?? "").map(wire) });
      case "conversations.history": {
        const latest = Number(args.latest ?? Infinity);
        const limit = Number(args.limit ?? 100);
        const top = (this.messages.get(args.channel ?? "") ?? [])
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
          .filter((m) => Number(m.ts) < latest)
          .reverse()
          .slice(0, limit);
        return ok({ messages: top.map(wire) });
      }
      case "chat.postMessage": {
        const message = this.append(args.channel ?? "", {
          user: this.botUserId,
          bot_id: BOT_ID,
          text: args.text ?? "",
          thread_ts: args.thread_ts,
          edits: [],
        });
        return ok({ channel: args.channel, ts: message.ts });
      }
      case "chat.update": {
        const message = this.messages
          .get(args.channel ?? "")
          ?.find((m) => m.ts === args.ts);
        if (!message) return fail("message_not_found");
        message.edits.push(message.text);
        message.text = args.text ?? "";
        return ok({ channel: args.channel, ts: args.ts });
      }
      case "chat.postEphemeral":
        this.ephemerals.push({
          channel: args.channel ?? "",
          user: args.user ?? "",
          text: args.text ?? "",
          thread_ts: args.thread_ts,
        });
        return ok({ message_ts: `${this.clock}.000000` });
      case "files.info": {
        const file = this.files.get(args.file ?? "");
        if (!file) return fail("file_not_found");
        return ok({ file: this.fileInfo(file) });
      }
      case "files.getUploadURLExternal": {
        const id = `F${randomBytes(4).toString("hex").toUpperCase()}`;
        this.pendingUploads.set(id, { filename: args.filename ?? "file", size: 0 });
        return ok({ upload_url: `${this.url}/upload/${id}`, file_id: id });
      }
      case "files.completeUploadExternal": {
        const files = JSON.parse(args.files ?? "[]") as { id: string; title?: string }[];
        this.uploads.push({
          channel: args.channel_id ?? "",
          thread_ts: args.thread_ts,
          files: files.map((file) => ({
            title: file.title,
            filename: this.pendingUploads.get(file.id)?.filename ?? "file",
            size: this.pendingUploads.get(file.id)?.size ?? 0,
          })),
        });
        return ok({ files: files.map((file) => ({ id: file.id })) });
      }
      default:
        return fail("unknown_method");
    }
  }
}

/** A message as the Web API returns it (without the test's own edit history) */
function wire(message: FakeMessage): Record<string, unknown> {
  return Object.fromEntries(Object.entries(message).filter(([key]) => key !== "edits"));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The Web API's arguments: form-encoded (objects as JSON strings) or a JSON body */
function parseArgs(body: Buffer, contentType: string): Record<string, string> {
  const text = body.toString("utf8");
  if (!text) return {};
  if (contentType.includes("application/json")) {
    const json = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ])
    );
  }
  return Object.fromEntries(new URLSearchParams(text));
}
