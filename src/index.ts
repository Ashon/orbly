import path from "node:path";
import { configFingerprint, loadConfig } from "./config.js";
import { HistoryStore } from "./history/recorder.js";
import { consoleSink, createLogger, fileSink, type Logger } from "./logger.js";
import { InflightStore } from "./mention/inflight.js";
import { MentionResponder } from "./mention/responder.js";
import { connectSlack } from "./messengers/slack/connect.js";
import { DockerExecutor, HostExecutor } from "./reasoner/executor.js";
import { createReasoner } from "./reasoner/index.js";
import { DiagramRenderer } from "./render/diagrams.js";
import { RECHECK_SANDBOX, SandboxHealth } from "./runtime/sandbox-health.js";
import { BotStatusFile, LOG_FILE } from "./runtime/status.js";
import { botLockDirs, warnOnce } from "./settings/legacy.js";
import { loadEnv } from "./settings/load-env.js";

/** The channel to the desktop app when it runs the bot as an Electron utilityProcess; absent in a terminal */
function parentPort():
  | { on(event: "message", listener: (event: { data: unknown }) => void): void }
  | undefined {
  return (process as { parentPort?: ReturnType<typeof parentPort> }).parentPort;
}

/** Holds the logger once created, so startup failures also reach the log file. */
let startupLog: Logger | undefined;
/** Set once the bot receives mentions; failures before that are startup failures */
let running = false;

async function main(): Promise<void> {
  // The settings file and the names from before the renames (ORBLY_*, VERDA_*, ~/.orbly, ~/.verda); warnings go to the log below.
  const envWarnings = loadEnv();
  const config = loadConfig();
  // Logs to PACENOTE_DATA_DIR/logs/bot.log as well as the console. The desktop app shows this file.
  const log = createLogger(config.logLevel, "pacenote", [
    consoleSink,
    fileSink(path.join(config.dataDir, LOG_FILE)),
  ]);
  startupLog = log;
  warnOnce(envWarnings, (message) => log.warn(message));
  const status = await BotStatusFile.acquire(
    config.dataDir,
    process.env.PACENOTE_MANAGED_BY === "desktop" ? "desktop" : "terminal",
    undefined,
    botLockDirs(config.dataDir).slice(1)
  );
  status.update({ configHash: configFingerprint(process.env) });
  log.info(`Starting (pid ${process.pid}, ${status.current.managedBy})`);

  let stopping = false;
  const connection = await connectSlack({
    config,
    log,
    onState: (state) => status.socket(state),
    onFatal: (err) => {
      log.error(err.message);
      process.exit(1);
    },
  });
  const { messenger, bot } = connection;
  /** Problems fixed for this process's life (diagram rendering); the sandbox's come from sandboxHealth */
  const problems: string[] = [];

  const executor = config.reasoner.sandbox
    ? new DockerExecutor(config.reasoner.sandbox)
    : new HostExecutor({
        claude: config.reasoner.claudeBin,
        codex: config.reasoner.codexBin,
      });
  const reasoner = createReasoner(config.reasoner, executor);
  // If the sandbox is not ready, reasoner calls fail. They do not fall back to the host.
  // The check repeats while the bot runs, and right away when the desktop app finishes a sandbox job, so the
  // status (and the status bar) follows a proxy that is started or stopped later.
  const allProblems = () => [
    ...sandboxHealth.current.map((problem) => `Sandbox: ${problem}`),
    ...problems,
  ];
  const sandboxHealth = new SandboxHealth(
    () => executor.verify(),
    () => status.update({ problems: allProblems() }),
    log
  );
  await sandboxHealth.check();
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
    messengers: [messenger],
    reasoner,
    log: log.child("mention"),
    extractPdfText: (pdfPath) => executor.extractPdfText(pdfPath),
    renderer,
    inflight: new InflightStore(path.join(config.dataDir, "inflight.json")),
    history,
    onActivity: (requests) => status.update({ requests }),
  });

  status.update({
    bot,
    reasoner: `${reasoner.backend}@${executor.kind}`,
    mcp: reasoner.mcpServerNames,
    diagrams: renderer !== undefined,
    history: history !== undefined,
    problems: allProblems(),
  });
  await connection.start((mention) => responder.handle(mention));
  status.update({ state: "running" });
  running = true;
  if (executor.kind === "docker") {
    sandboxHealth.start(30_000);
    parentPort()?.on("message", (event) => {
      if ((event.data as { type?: string } | undefined)?.type === RECHECK_SANDBOX)
        void sandboxHealth.check();
    });
  }
  await responder.resumePending();
  const allowed = config.mention.allowedUserIds;
  log.info(
    `Started: ${messenger.profile.name} bot=${bot.user} (${bot.userId}) @ ${bot.team}, ` +
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
    await connection.stop().catch(() => undefined);
    // Unfinished requests stay in PACENOTE_DATA_DIR/inflight.json and resume on the next start.
    if (!(await responder.drain(20_000)))
      log.warn("Shutting down with requests still in progress.");
    log.info(`Stopped (pid ${process.pid})`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const fail = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const text = running
    ? `Stopped on an unhandled error: ${message}`
    : `Startup failed: ${message}`;
  if (startupLog) startupLog.error(text);
  else console.error(text);
  process.exit(1);
};
// Bolt checks the token on its own as well, and a rejected token fails that check outside main(). It should end the
// bot with a message in the log (which the desktop app reads for "Setup needed"), not a stack dump.
process.on("unhandledRejection", fail);
main().catch(fail);
