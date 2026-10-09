import path from "node:path";
import { App, SocketModeReceiver } from "@slack/bolt";
import { configFingerprint, loadConfig } from "./config.js";
import { HistoryStore } from "./history/recorder.js";
import { consoleSink, createLogger, fileSink, type Logger } from "./logger.js";
import { InflightStore } from "./mention/inflight.js";
import { MentionResponder } from "./mention/responder.js";
import { DockerExecutor, HostExecutor } from "./reasoner/executor.js";
import { createReasoner } from "./reasoner/index.js";
import { DiagramRenderer } from "./render/diagrams.js";
import { BotStatusFile, LOG_FILE } from "./runtime/status.js";
import type { SocketState } from "./runtime/types.js";
import { Directory } from "./slack/directory.js";
import { slackLogger } from "./slack/logger.js";

const SOCKET_STATES: Record<SocketState, { level: "info" | "warn"; text: string }> = {
  connecting: { level: "info", text: "Connecting to Slack" },
  connected: { level: "info", text: "Socket Mode connected, receiving events" },
  reconnecting: { level: "warn", text: "Socket Mode reconnecting" },
  disconnecting: { level: "info", text: "Closing Socket Mode connection" },
  disconnected: { level: "warn", text: "Socket Mode disconnected" },
};

/** Holds the logger once created, so startup failures also reach the log file. */
let startupLog: Logger | undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  // Logs to VERDA_DATA_DIR/logs/bot.log as well as the console. The desktop app shows this file.
  const log = createLogger(config.logLevel, "verda", [
    consoleSink,
    fileSink(path.join(config.dataDir, LOG_FILE)),
  ]);
  startupLog = log;
  const status = await BotStatusFile.acquire(
    config.dataDir,
    process.env.VERDA_MANAGED_BY === "desktop" ? "desktop" : "terminal"
  );
  status.update({ configHash: configFingerprint(process.env) });
  log.info(`Starting (pid ${process.pid}, ${status.current.managedBy})`);

  // Sends Socket Mode client and Bolt logs to the same logger (console + file).
  const socketLog = log.child("socket");
  const receiver = new SocketModeReceiver({
    appToken: config.slack.appToken,
    logger: slackLogger(socketLog, config.logLevel),
    clientPingTimeout: config.slack.socket.clientPingTimeoutMs,
    serverPingTimeout: config.slack.socket.serverPingTimeoutMs,
    pingPongLoggingEnabled: config.slack.socket.pingPongLogging,
  });
  let stopping = false;
  for (const state of Object.keys(SOCKET_STATES) as SocketState[]) {
    receiver.client.on(state, () => {
      status.socket(state);
      const { level, text } = SOCKET_STATES[state];
      // Disconnecting during shutdown is expected.
      socketLog[stopping && level === "warn" ? "info" : level](text);
    });
  }
  receiver.client.on(
    "slack_event",
    (args: {
      type?: string;
      envelope_id?: string;
      retry_num?: number;
      body?: { event?: { type?: string } };
    }) => {
      const kind = [args.type, args.body?.event?.type].filter(Boolean).join("/");
      socketLog.info(
        `Received event ${kind} (envelope ${args.envelope_id ?? "-"}${args.retry_num ? `, retry ${args.retry_num}` : ""})`
      );
    }
  );

  const app = new App({
    token: config.slack.botToken,
    receiver,
    logger: slackLogger(log.child("bolt"), config.logLevel),
  });
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) throw new Error("Could not determine the bot user ID.");
  const problems: string[] = [];

  const executor = config.reasoner.sandbox
    ? new DockerExecutor(config.reasoner.sandbox)
    : new HostExecutor({
        claude: config.reasoner.claudeBin,
        codex: config.reasoner.codexBin,
      });
  const reasoner = createReasoner(config.reasoner, executor);
  // If the sandbox is not ready, reasoner calls fail. They do not fall back to the host.
  for (const problem of await executor.verify()) {
    log.error(`Sandbox: ${problem}`);
    problems.push(`Sandbox: ${problem}`);
  }
  if (config.mention.workspace && !reasoner.canReadFiles) {
    log.warn(
      `${reasoner.backend} cannot read files in the ${executor.kind} sandbox, so MENTION_WORKSPACE is not used.`
    );
  }

  let renderer: DiagramRenderer | undefined;
  if (config.render.enabled) {
    const candidate = new DiagramRenderer({
      dockerBin: config.render.dockerBin,
      image: config.render.image,
      timeoutMs: 60_000,
    });
    const rendererProblems = await candidate.verify();
    for (const problem of rendererProblems) {
      log.warn(`Diagram rendering disabled: ${problem}`);
      problems.push(`Diagram rendering disabled: ${problem}`);
    }
    if (rendererProblems.length === 0) renderer = candidate;
  }

  const history = config.history
    ? new HistoryStore(config.dataDir, log.child("history"))
    : undefined;
  const pruneHistory = () => {
    if (!history || !config.history) return;
    try {
      const removed = history.prune(config.history.retentionDays);
      if (removed > 0)
        log.info(
          `Deleted ${removed} ${removed === 1 ? "day" : "days"} of run history past the retention period.`
        );
    } catch (err) {
      log.warn(`Run history cleanup failed: ${(err as Error).message}`);
    }
  };
  pruneHistory();
  setInterval(pruneHistory, 6 * 60 * 60_000).unref();

  const responder = new MentionResponder({
    config,
    client: app.client,
    reasoner,
    directory: new Directory(app.client, log.child("directory")),
    log: log.child("mention"),
    botUserId,
    extractPdfText: (pdfPath) => executor.extractPdfText(pdfPath),
    renderer,
    inflight: new InflightStore(path.join(config.dataDir, "inflight.json")),
    history,
    workspaceUrl: auth.url,
    onActivity: (requests) => status.update({ requests }),
  });

  app.event("app_mention", async ({ event }) => {
    await responder.handle(event);
  });
  app.error(async (err) => {
    log.error("Slack event handling error", err);
  });

  status.update({
    bot: { user: auth.user ?? botUserId, userId: botUserId, team: auth.team ?? "" },
    reasoner: `${reasoner.backend}@${executor.kind}`,
    mcp: reasoner.mcpServerNames,
    diagrams: renderer !== undefined,
    history: history !== undefined,
    problems,
  });
  await app.start();
  status.update({ state: "running" });
  await responder.resumePending();
  const allowed = config.mention.allowedUserIds;
  log.info(
    `Started: bot=${auth.user} (${botUserId}) @ ${auth.team}, ` +
      `reasoner=${reasoner.backend}@${executor.kind}, ` +
      `allowed users=${allowed.length > 0 ? `${allowed.length}` : "all"}, ` +
      `reference directory=${config.mention.workspace && reasoner.canReadFiles ? config.mention.workspace : "none"}, ` +
      `MCP=[${reasoner.mcpServerNames.join(", ")}], diagrams=${renderer ? "on" : "off"}, ` +
      `data=${config.dataDir}${history ? "" : " (history off)"}`
  );

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    status.update({ state: "stopping" });
    log.info(
      `Received ${signal}, waiting for in-progress requests before shutting down.`
    );
    await app.stop().catch(() => undefined);
    // Unfinished requests stay in VERDA_DATA_DIR/inflight.json and resume on the next start.
    if (!(await responder.drain(20_000)))
      log.warn("Shutting down with requests still in progress.");
    log.info(`Stopped (pid ${process.pid})`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (startupLog) startupLog.error(`Startup failed: ${message}`);
  else console.error(message);
  process.exit(1);
});
