import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeLineToEvents, codexLineToEvents, lastMessage } from "../history/events.js";
import type { RunEvent } from "../history/types.js";
import type { Executor } from "./executor.js";
import { ProcessExitError } from "./process.js";

export type ReasonerBackend = "claude" | "codex";

/** 모델에 함께 넘길 이미지 (호스트 경로). 모두 같은 디렉터리에 있어야 한다. */
export interface ReasonImage {
  path: string;
  mimetype: string;
}

export interface ReasonRequest {
  system: string;
  prompt: string;
  images?: ReasonImage[];
  /** CLI 가 만든 산출물(codex 생성 이미지)을 받을 호스트 디렉터리 */
  outputDir?: string;
  /** 읽기 전용으로 참고할 디렉터리. canReadFiles 가 false 면 무시된다. */
  readOnlyDir?: string;
  signal?: AbortSignal;
  /** CLI 가 진행 단계(메시지, 도구 호출, 사용량)를 출력할 때마다 호출된다. */
  onEvent?: (event: RunEvent) => void;
}

/** 로컬 CLI(claude, codex)로 한 번 추론해서 최종 텍스트를 받는다. */
export interface Reasoner {
  readonly backend: ReasonerBackend;
  /** 실행 위치. host 또는 docker 샌드박스 */
  readonly sandbox: Executor["kind"];
  /** 참고 디렉터리의 파일을 읽을 수 있는지 */
  readonly canReadFiles: boolean;
  /** 붙어 있는 MCP 서버 이름 */
  readonly mcpServerNames: string[];
  complete(request: ReasonRequest): Promise<string>;
}

/** 추론 CLI 에 붙일 MCP 서버 (Streamable HTTP) */
export interface McpServerRef {
  name: string;
  url: string;
}

export interface ReasonerOptions {
  backend: ReasonerBackend;
  model?: string;
  /** codex 의 model_reasoning_effort. 샌드박스에서는 호스트 설정을 못 읽어서 명시한다. */
  codexReasoningEffort?: string;
  timeoutMs: number;
  mcpServers?: McpServerRef[];
}

const READ_ONLY_TOOLS = "Read,Grep,Glob";

/**
 * claude -p 인자. 사용자 설정, 훅, MCP 를 읽지 않는 격리 실행이다.
 * readOnly 이면 읽기 도구만 허용하고 나머지 권한 요청은 자동 거부(dontAsk)한다.
 * 셸, 웹, 파일 쓰기 도구는 어떤 경우에도 주지 않는다.
 */
export function claudeArgs(options: {
  system: string;
  model?: string;
  readOnly: boolean;
  mcpServers?: McpServerRef[];
  /** 이미지가 있으면 stdin 을 stream-json(이미지 블록 포함)으로 넘긴다. */
  streamInput?: boolean;
}): string[] {
  const mcpServers = options.mcpServers ?? [];
  // 진행 단계를 기록하려고 출력은 항상 stream-json 으로 받는다. 마지막 줄이 최종 결과다.
  const args = [
    "-p",
    ...(options.streamInput ? ["--input-format", "stream-json"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--effort",
    "medium",
    "--system-prompt",
    options.system,
  ];
  if (options.model) args.push("--model", options.model);
  args.push("--tools", options.readOnly ? READ_ONLY_TOOLS : "");

  // 허용 목록에 있는 도구만 쓰고, 그 밖의 권한 요청은 자동 거부(dontAsk)한다.
  const allowed = [
    ...(options.readOnly ? [READ_ONLY_TOOLS] : []),
    ...mcpServers.map((server) => `mcp__${server.name}`),
  ];
  if (allowed.length > 0) {
    args.push("--allowedTools", allowed.join(","), "--permission-mode", "dontAsk");
  }
  if (mcpServers.length > 0) {
    const config = Object.fromEntries(
      mcpServers.map((server) => [server.name, { type: "http", url: server.url }])
    );
    args.push("--mcp-config", JSON.stringify({ mcpServers: config }));
  }
  return args;
}

/**
 * codex exec 인자. 프롬프트는 stdin(-)으로 넘기고 stdout 으로 진행 이벤트(JSONL)를 받는다.
 * ChatGPT 계정에 연결된 앱 커넥터(codex_apps, 예: GitHub)는 끈다. 권한 범위가 다르고 데이터가
 * 다른 경로로 나가므로, 외부 시스템 조회는 ops-broker 도구로만 한다.
 * codex 는 셸 도구를 끌 수 없어서 read-only 샌드박스(쓰기, 네트워크 차단)와
 * approval_policy=never(권한 상승 요청 없음)로 제한한다.
 */
export function codexArgs(options: {
  model?: string;
  reasoningEffort?: string;
  mcpServers?: McpServerRef[];
  /** 컨테이너(또는 호스트) 기준 이미지 경로 */
  images?: string[];
}): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "--color",
    "never",
    "--json",
    "--disable",
    "apps",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
  for (const server of options.mcpServers ?? []) {
    args.push("-c", `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`);
    // approval_policy=never 에서는 읽기 전용이 아닌 MCP 도구가 거부된다.
    // 허용/거부 판단은 broker 의 정책 검사가 하므로 이 서버의 도구는 자동 승인한다.
    args.push("-c", `mcp_servers.${server.name}.default_tools_approval_mode="approve"`);
  }
  // --image 는 값을 여러 개 받는 옵션이라 = 형식으로 하나씩 넘겨야 뒤의 - 를 먹지 않는다.
  for (const image of options.images ?? []) args.push(`--image=${image}`);
  args.push("-");
  return args;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export function parseClaudeOutput(stdout: string): string {
  let parsed: ClaudeJsonResult;
  try {
    // stream-json 이면 마지막 result 줄을, json 이면 전체를 읽는다.
    const lines = stdout.trim().split("\n");
    const resultLine =
      lines.length > 1
        ? lines.reverse().find((line) => line.includes('"type":"result"'))
        : lines[0];
    parsed = JSON.parse(resultLine ?? "") as ClaudeJsonResult;
  } catch {
    throw new Error(`claude 출력이 JSON 이 아닙니다: ${stdout.slice(0, 200)}`);
  }
  if (
    parsed.is_error ||
    parsed.subtype !== "success" ||
    typeof parsed.result !== "string"
  ) {
    const kind =
      parsed.subtype && parsed.subtype !== "success" ? ` (${parsed.subtype})` : "";
    throw new Error(`claude 실행 실패${kind}: ${parsed.result ?? ""}`);
  }
  return parsed.result.trim();
}

class ClaudeCliReasoner implements Reasoner {
  readonly backend = "claude" as const;
  readonly sandbox: Executor["kind"];
  readonly canReadFiles: boolean;
  readonly mcpServerNames: string[];

  constructor(
    private readonly options: ReasonerOptions,
    private readonly executor: Executor
  ) {
    this.sandbox = executor.kind;
    this.mcpServerNames = (options.mcpServers ?? []).map((server) => server.name);
    this.canReadFiles = executor.canReadFiles("claude");
  }

  async complete(request: ReasonRequest): Promise<string> {
    const referenceDir = this.canReadFiles ? request.readOnlyDir : undefined;
    const images = request.images ?? [];
    const onEvent = request.onEvent;
    const run = this.executor.run({
      tool: "claude",
      args: claudeArgs({
        system: request.system,
        model: this.options.model,
        readOnly: referenceDir !== undefined,
        mcpServers: this.options.mcpServers,
        streamInput: images.length > 0,
      }),
      // 이미지는 마운트 없이 stdin 의 base64 블록으로 넘긴다.
      input:
        images.length > 0
          ? await claudeStreamInput(request.prompt, images)
          : request.prompt,
      referenceDir,
      timeoutMs: this.options.timeoutMs,
      signal: request.signal,
      onOutputLine: onEvent
        ? (line) => claudeLineToEvents(line).forEach((event) => onEvent(event))
        : undefined,
    });
    try {
      return parseClaudeOutput((await run).stdout);
    } catch (err) {
      // 인증 실패 등은 종료 코드 1 과 함께 결과 JSON 이 stdout 에 온다. 그 안의 원인을 보여준다.
      if (err instanceof ProcessExitError && err.stdout.includes('"type":"result"')) {
        parseClaudeOutput(err.stdout);
      }
      throw err;
    }
  }
}

class CodexCliReasoner implements Reasoner {
  readonly backend = "codex" as const;
  readonly sandbox: Executor["kind"];
  readonly canReadFiles: boolean;
  readonly mcpServerNames: string[];

  constructor(
    private readonly options: ReasonerOptions,
    private readonly executor: Executor
  ) {
    this.sandbox = executor.kind;
    this.mcpServerNames = (options.mcpServers ?? []).map((server) => server.name);
    this.canReadFiles = executor.canReadFiles("codex");
  }

  async complete(request: ReasonRequest): Promise<string> {
    const images = request.images ?? [];
    const attachmentsDir = images[0] ? path.dirname(images[0].path) : undefined;
    const onEvent = request.onEvent;
    const run = this.executor.run({
      tool: "codex",
      args: codexArgs({
        model: this.options.model,
        reasoningEffort: this.options.codexReasoningEffort,
        mcpServers: this.options.mcpServers,
        images: images.map((image) => this.executor.attachmentPath(image.path)),
      }),
      attachmentsDir,
      outputDir: request.outputDir,
      // codex exec 에는 별도 system prompt 옵션이 없어 지시문을 앞에 붙인다.
      input: `<instructions>\n${request.system}\n</instructions>\n\n${request.prompt}`,
      referenceDir: this.canReadFiles ? request.readOnlyDir : undefined,
      timeoutMs: this.options.timeoutMs,
      signal: request.signal,
      onOutputLine: onEvent
        ? (line) => codexLineToEvents(line).forEach((event) => onEvent(event))
        : undefined,
    });
    let stdout: string;
    try {
      ({ stdout } = await run);
    } catch (err) {
      // 실패 원인은 stdout 의 error 이벤트에 있다.
      const reason = err instanceof ProcessExitError ? codexError(err.stdout) : undefined;
      if (reason) throw new Error(`codex 실행 실패: ${reason}`, { cause: err });
      throw err;
    }
    return parseCodexOutput(stdout);
  }
}

/** codex --json 출력에서 마지막 agent_message 를 최종 답으로 읽는다. */
export function parseCodexOutput(stdout: string): string {
  const events = stdout.split("\n").flatMap((line) => codexLineToEvents(line));
  const answer = lastMessage(events);
  if (answer) return answer;
  const reason = codexError(stdout);
  throw new Error(
    reason ? `codex 실행 실패: ${reason}` : "codex 가 빈 응답을 반환했습니다."
  );
}

function codexError(stdout: string): string | undefined {
  const errors = stdout
    .split("\n")
    .flatMap((line) => codexLineToEvents(line))
    .flatMap((event) => (event.kind === "error" ? [event.message] : []));
  return errors.at(-1);
}

/** claude stream-json 입력: 이미지 블록들 뒤에 텍스트 프롬프트를 붙인 사용자 메시지 한 줄 */
export async function claudeStreamInput(
  prompt: string,
  images: ReasonImage[]
): Promise<string> {
  const blocks = await Promise.all(
    images.map(async (image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimetype,
        data: (await readFile(image.path)).toString("base64"),
      },
    }))
  );
  const message = { role: "user", content: [...blocks, { type: "text", text: prompt }] };
  return `${JSON.stringify({ type: "user", message })}\n`;
}

export function createReasoner(options: ReasonerOptions, executor: Executor): Reasoner {
  return options.backend === "codex"
    ? new CodexCliReasoner(options, executor)
    : new ClaudeCliReasoner(options, executor);
}
