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
  connecting: { level: "info", text: "Slack 에 연결하는 중" },
  connected: { level: "info", text: "Socket Mode 연결됨, 이벤트 수신 중" },
  reconnecting: { level: "warn", text: "Socket Mode 재연결 중" },
  disconnecting: { level: "info", text: "Socket Mode 연결을 닫는 중" },
  disconnected: { level: "warn", text: "Socket Mode 연결 끊김" },
};

/** 시작 실패도 로그 파일에 남기려고 로거가 만들어지면 여기에 둔다. */
let startupLog: Logger | undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  // 콘솔과 함께 VERDA_DATA_DIR/logs/bot.log 에 남긴다. 데스크톱 앱이 이 파일을 보여 준다.
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
  log.info(`시작 중 (pid ${process.pid}, ${status.current.managedBy})`);

  // Socket Mode 클라이언트와 Bolt 로그도 같은 로거(콘솔 + 파일)로 보낸다.
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
      // 종료하면서 끊는 것은 정상이다.
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
        `이벤트 수신 ${kind} (envelope ${args.envelope_id ?? "-"}${args.retry_num ? `, 재전송 ${args.retry_num}회` : ""})`
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
  if (!botUserId) throw new Error("봇 사용자 ID 를 확인할 수 없습니다.");
  const problems: string[] = [];

  const executor = config.reasoner.sandbox
    ? new DockerExecutor(config.reasoner.sandbox)
    : new HostExecutor({
        claude: config.reasoner.claudeBin,
        codex: config.reasoner.codexBin,
      });
  const reasoner = createReasoner(config.reasoner, executor);
  // 샌드박스가 준비되지 않았으면 추론 호출은 실패한다. 호스트 실행으로 대신하지 않는다.
  for (const problem of await executor.verify()) {
    log.error(`샌드박스: ${problem}`);
    problems.push(`샌드박스: ${problem}`);
  }
  if (config.mention.workspace && !reasoner.canReadFiles) {
    log.warn(
      `${reasoner.backend} 는 ${executor.kind} 샌드박스에서 파일을 읽을 수 없어 MENTION_WORKSPACE 를 쓰지 않습니다.`
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
      log.warn(`그림 렌더링 꺼짐: ${problem}`);
      problems.push(`그림 렌더링 꺼짐: ${problem}`);
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
        log.info(`보관 기간이 지난 실행 기록 ${removed}일치를 지웠습니다.`);
    } catch (err) {
      log.warn(`실행 기록 정리 실패: ${(err as Error).message}`);
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
    inflight: new InflightStore("data/inflight.json"),
    history,
    workspaceUrl: auth.url,
    onActivity: (requests) => status.update({ requests }),
  });

  app.event("app_mention", async ({ event }) => {
    await responder.handle(event);
  });
  app.error(async (err) => {
    log.error("Slack 이벤트 처리 오류", err);
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
    `시작: bot=${auth.user} (${botUserId}) @ ${auth.team}, ` +
      `reasoner=${reasoner.backend}@${executor.kind}, ` +
      `허용 사용자=${allowed.length > 0 ? `${allowed.length}명` : "전체"}, ` +
      `참고 디렉터리=${config.mention.workspace && reasoner.canReadFiles ? config.mention.workspace : "없음"}, ` +
      `MCP=[${reasoner.mcpServerNames.join(", ")}], 그림=${renderer ? "on" : "off"}, ` +
      `데이터=${config.dataDir}${history ? "" : " (기록 off)"}`
  );

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    status.update({ state: "stopping" });
    log.info(`${signal} 수신, 처리 중인 요청을 기다린 뒤 종료합니다.`);
    await app.stop().catch(() => undefined);
    // 끝나지 않은 요청은 data/inflight.json 에 남아 다음 시작 때 이어서 처리된다.
    if (!(await responder.drain(20_000))) log.warn("처리 중인 요청을 남기고 종료합니다.");
    log.info(`종료 (pid ${process.pid})`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (startupLog) startupLog.error(`시작 실패: ${message}`);
  else console.error(message);
  process.exit(1);
});
