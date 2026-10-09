import type { App, Receiver } from "@slack/bolt";
import WebSocket from "ws";
import { HUB_CLOSE, HUB_PATHS, type HubMessage, PING, PONG } from "../hub/protocol.js";
import type { Logger } from "../logger.js";
import type { SocketState } from "../runtime/types.js";

const PING_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export interface HubReceiverOptions {
  /** The hub's URL (https://...), without a trailing slash */
  url: string;
  token: string;
  log: Logger;
  /** Connection state, reported like Socket Mode's so the status and UI read the same */
  onState: (state: SocketState) => void;
  /** The hub no longer accepts this desktop (unpaired, or its token is unknown). The bot should stop. */
  onFatal: (error: Error) => void;
  /** For tests */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

/**
 * Receives this member's mentions from the team hub (src/hub) instead of Slack's Socket Mode, and hands them to
 * Bolt. Reconnects with backoff when the connection drops. A 401 or an unpairing stops it for good (onFatal); another
 * desktop of the same member taking over leaves this one disconnected, without reconnecting, so two desktops do not
 * keep taking the connection from each other.
 */
export class HubReceiver implements Receiver {
  private app?: App;
  private ws?: WebSocket;
  private stopped = false;
  private attempt = 0;
  private timers: NodeJS.Timeout[] = [];
  /** When anything last arrived from the hub; a PING unanswered past PONG_TIMEOUT_MS drops the connection */
  private lastHeard = 0;

  constructor(private readonly options: HubReceiverOptions) {}

  init(app: App): void {
    this.app = app;
  }

  /** Resolves once the hub says ready. Rejects only when the hub refuses this desktop. */
  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => this.connect(resolve, reject));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.options.onState("disconnecting");
    this.ws?.close(1000, "Stopping");
  }

  private connect(onReady?: () => void, onRefused?: (error: Error) => void): void {
    const { log, onState } = this.options;
    const url = `${this.options.url.replace(/^http/, "ws")}${HUB_PATHS.connect}`;
    const headers = { Authorization: `Bearer ${this.options.token}` };
    onState(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws =
      this.options.createSocket?.(url, headers) ?? new WebSocket(url, { headers });
    this.ws = ws;
    let ready = false;

    const refuse = (error: Error) => {
      this.stopped = true;
      this.clearTimers();
      onState("disconnected");
      if (onRefused && !ready) onRefused(error);
      else this.options.onFatal(error);
    };

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401)
        refuse(
          new Error(
            "The team hub does not recognize this desktop (hub_unauthorized). Connect again in Settings > Slack."
          )
        );
      else log.warn(`The hub answered HTTP ${res.statusCode}; retrying.`);
      ws.terminate();
    });
    ws.on("error", (err) => log.warn(`Hub connection error: ${err.message}`));
    ws.on("message", (data) => {
      this.lastHeard = Date.now();
      const text = data.toString();
      if (text === PONG) return;
      let message: HubMessage;
      try {
        message = JSON.parse(text) as HubMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "ready":
          ready = true;
          this.attempt = 0;
          onState("connected");
          log.info(
            `Connected to the team hub as ${message.user.name} (${message.user.id}) @ ${message.team.name}`
          );
          this.keepAlive(ws);
          onReady?.();
          break;
        case "event":
          this.dispatch(message.body);
          break;
        case "revoked":
          log.warn(`The hub disconnected this desktop: ${message.reason}`);
          break;
      }
    });
    ws.on("close", (code, reason) => {
      this.clearTimers();
      if (this.stopped) return onState("disconnected");
      if (code === HUB_CLOSE.revoked)
        return refuse(
          new Error(
            "This desktop was disconnected from the team hub (hub_revoked). Connect again in Settings > Slack."
          )
        );
      if (code === HUB_CLOSE.replaced) {
        this.stopped = true;
        onState("disconnected");
        log.warn(
          `Another connection took over at the hub (${reason.toString() || "replaced"}). ` +
            "This desktop stops receiving mentions until the bot restarts."
        );
        return;
      }
      this.attempt += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt - 1, 5));
      onState("reconnecting");
      log.warn(`Hub connection closed (${code}); reconnecting in ${delay / 1000}s.`);
      this.timers.push(setTimeout(() => this.connect(onReady, onRefused), delay));
    });
  }

  private dispatch(body: Record<string, unknown>): void {
    const event = body.event as { type?: string } | undefined;
    this.options.log.info(
      `Received event ${[body.type, event?.type].filter(Boolean).join("/")} from the hub`
    );
    this.app
      ?.processEvent({ body, ack: async () => undefined })
      .catch((err: unknown) =>
        this.options.log.error(`Event handling failed: ${(err as Error).message}`)
      );
  }

  /** Sends PING regularly and drops a connection whose PONG does not come back. */
  private keepAlive(ws: WebSocket): void {
    const ping = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      const sentAt = Date.now();
      ws.send(PING);
      this.timers.push(
        setTimeout(() => {
          if (this.lastHeard < sentAt) ws.terminate();
        }, PONG_TIMEOUT_MS)
      );
    }, PING_EVERY_MS);
    this.timers.push(ping);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
  }
}
