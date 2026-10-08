import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runProcess, type RunResult } from "./process.js";

export type CliTool = "claude" | "codex";

export interface CliInvocation {
  tool: CliTool;
  args: string[];
  input: string;
  /** 읽기 전용으로 참고할 호스트 디렉터리. CLI 의 작업 디렉터리가 된다. */
  referenceDir?: string;
  /** 첨부 이미지가 있는 호스트 디렉터리. 도커에서는 /attachments 로 읽기 전용 마운트한다. */
  attachmentsDir?: string;
  /** CLI 가 만든 산출물(codex 생성 이미지)을 받을 호스트 디렉터리. 도커에서는 /out 으로 마운트한다. */
  outputDir?: string;
  /** CLI stdout 한 줄마다 호출된다. (이벤트 스트림) */
  onOutputLine?: (line: string) => void;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** CLI 를 어디서 실행할지. 호스트 그대로 또는 일회용 도커 컨테이너. */
export interface Executor {
  readonly kind: "host" | "docker";
  /** 이 실행 환경에서 해당 CLI 가 참고 디렉터리의 파일을 읽을 수 있는지 */
  canReadFiles(tool: CliTool): boolean;
  /** 첨부 파일의 호스트 경로를 CLI 가 보는 경로로 바꾼다. */
  attachmentPath(hostPath: string): string;
  /** PDF 에서 텍스트를 뽑는다. 도커에서는 네트워크 없는 일회용 컨테이너에서 실행한다. */
  extractPdfText(pdfPath: string): Promise<string>;
  run(invocation: CliInvocation): Promise<RunResult>;
  /** 실행 전제 조건 점검. 문제 목록을 돌려준다. */
  verify(): Promise<string[]>;
}

/** 앞 50쪽만, UTF-8 로, 경고 출력 없이 */
const PDFTOTEXT_ARGS = ["-l", "50", "-enc", "UTF-8", "-q"];

/**
 * PDF 텍스트 추출용 docker run 인자. 다른 사람이 올린 파일을 파싱하므로
 * 네트워크 없이, 읽기 전용 루트와 권한 제거 상태의 일회용 컨테이너에서 실행한다.
 */
export function pdfExtractArgs(image: string, pdfPath: string): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "--memory",
    "512m",
    "--pids-limit",
    "64",
    "--label",
    SANDBOX_LABEL,
    "-v",
    `${path.dirname(pdfPath)}:/in:ro`,
    "--entrypoint",
    "pdftotext",
    image,
    ...PDFTOTEXT_ARGS,
    `/in/${path.basename(pdfPath)}`,
    "-",
  ];
}

/**
 * 호스트에서 실행한 codex 의 생성 이미지는 ~/.codex/generated_images 에 남는다.
 * 실행 시작 이후 만들어진 파일만 outputDir 로 복사한다.
 */
async function collectCodexImages(outputDir: string, sinceMs: number): Promise<void> {
  const root = path.join(
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    "generated_images"
  );
  const sessions = await readdir(root).catch(() => [] as string[]);
  for (const session of sessions) {
    const dir = path.join(root, session);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs < sinceMs) continue;
      await mkdir(outputDir, { recursive: true });
      await copyFile(file, path.join(outputDir, `${session}-${name}`));
    }
  }
}

export class HostExecutor implements Executor {
  readonly kind = "host" as const;

  constructor(private readonly bins: Record<CliTool, string>) {}

  canReadFiles(): boolean {
    return true;
  }

  attachmentPath(hostPath: string): string {
    return hostPath;
  }

  async extractPdfText(pdfPath: string): Promise<string> {
    const { stdout } = await runProcess("pdftotext", [...PDFTOTEXT_ARGS, pdfPath, "-"], {
      cwd: path.dirname(pdfPath),
      input: "",
      timeoutMs: 60_000,
    });
    return stdout;
  }

  async run(invocation: CliInvocation): Promise<RunResult> {
    const started = Date.now();
    try {
      return await this.runInDir(invocation);
    } finally {
      if (invocation.outputDir && invocation.tool === "codex") {
        await collectCodexImages(invocation.outputDir, started);
      }
    }
  }

  private async runInDir(invocation: CliInvocation): Promise<RunResult> {
    const run = (cwd: string) =>
      runProcess(this.bins[invocation.tool], invocation.args, {
        cwd,
        input: invocation.input,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        onStdoutLine: invocation.onOutputLine,
      });
    if (invocation.referenceDir) return run(invocation.referenceDir);
    // 참고 디렉터리가 없으면 빈 임시 디렉터리에서 실행한다.
    const scratch = await mkdtemp(path.join(tmpdir(), "verda-"));
    try {
      return await run(scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async verify(): Promise<string[]> {
    return [];
  }
}

export interface DockerSandboxOptions {
  dockerBin: string;
  image: string;
  network: string;
  proxyUrl: string;
  memory: string;
  cpus: string;
  /** claude 실행 시 컨테이너에 넘길 인증 환경 변수 (CLAUDE_CODE_OAUTH_TOKEN 또는 ANTHROPIC_API_KEY) */
  claudeEnv: Record<string, string>;
  /** codex 실행 시 읽기 전용으로 마운트할 호스트 auth.json */
  codexAuthFile?: string;
  /** 프록시를 거치지 않고 내부 네트워크에서 직접 접속할 호스트 (예: ops-broker) */
  noProxy?: string[];
  /** 시작 시 실행 중인지 확인할 내부 서비스 컨테이너 이름 */
  requiredServices?: string[];
}

export const SANDBOX_LABEL = "verda.role=reasoner";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_EMPTY_DIR = "/work";
const CONTAINER_ATTACHMENTS = "/attachments";

/**
 * 일회용 추론 컨테이너의 docker run 인자.
 * - 루트 파일시스템 읽기 전용, HOME 과 /tmp 는 매번 비어 있는 tmpfs
 * - 모든 capability 제거, 권한 상승 금지, 프로세스/메모리/CPU 제한
 * - 내부 전용 네트워크에만 연결. 외부는 egress 프록시(허용 도메인)로만 나간다.
 * - 호스트 파일은 참고 디렉터리(읽기 전용)와 codex 인증 파일(읽기 전용)만 보인다.
 * - 비밀 값은 이름만 넘기고(-e NAME) 값은 docker CLI 프로세스 환경으로 전달한다. (ps 노출 방지)
 */
export function dockerRunArgs(
  options: DockerSandboxOptions,
  invocation: Pick<
    CliInvocation,
    "tool" | "args" | "referenceDir" | "attachmentsDir" | "outputDir"
  >,
  containerName: string
): string[] {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--label",
    SANDBOX_LABEL,
    "--network",
    options.network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    "/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    options.memory,
    "--cpus",
    options.cpus,
    "--user",
    "1000:1000",
    "-e",
    `HTTPS_PROXY=${options.proxyUrl}`,
    "-e",
    `HTTP_PROXY=${options.proxyUrl}`,
  ];
  if (options.noProxy?.length) {
    const list = options.noProxy.join(",");
    args.push("-e", `NO_PROXY=${list}`, "-e", `no_proxy=${list}`);
  }
  if (invocation.tool === "claude") {
    for (const name of Object.keys(options.claudeEnv)) args.push("-e", name);
  }
  if (invocation.tool === "codex" && options.codexAuthFile) {
    args.push("-v", `${options.codexAuthFile}:/run/secrets/codex-auth.json:ro`);
  }
  if (invocation.attachmentsDir) {
    args.push("-v", `${invocation.attachmentsDir}:${CONTAINER_ATTACHMENTS}:ro`);
  }
  // 컨테이너의 유일한 쓰기 가능 호스트 경로. entrypoint 가 ~/.codex/generated_images 를 여기로 잇는다.
  if (invocation.outputDir && invocation.tool === "codex") {
    args.push("-v", `${invocation.outputDir}:/out`);
  }
  if (invocation.referenceDir) {
    args.push("-v", `${invocation.referenceDir}:${CONTAINER_WORKSPACE}:ro`);
    args.push("-w", CONTAINER_WORKSPACE);
  } else {
    args.push("-w", CONTAINER_EMPTY_DIR);
  }
  args.push(options.image, invocation.tool, ...invocation.args);
  return args;
}

export class DockerExecutor implements Executor {
  readonly kind = "docker" as const;

  constructor(private readonly options: DockerSandboxOptions) {}

  /**
   * codex 는 셸로 파일을 읽는데, 강화된 컨테이너 안에서는 codex 자체 샌드박스(bubblewrap)가
   * namespace 를 만들 수 없어 명령 실행이 거부된다. 바깥 격리를 풀지 않는 대신 파일 참고를 끈다.
   */
  canReadFiles(tool: CliTool): boolean {
    return tool === "claude";
  }

  attachmentPath(hostPath: string): string {
    return `${CONTAINER_ATTACHMENTS}/${path.basename(hostPath)}`;
  }

  async extractPdfText(pdfPath: string): Promise<string> {
    const { stdout } = await runProcess(
      this.options.dockerBin,
      pdfExtractArgs(this.options.image, pdfPath),
      { cwd: process.cwd(), input: "", timeoutMs: 60_000 }
    );
    return stdout;
  }

  async run(invocation: CliInvocation): Promise<RunResult> {
    const name = `verda-reasoner-${randomUUID().slice(0, 8)}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (invocation.tool === "claude") Object.assign(env, this.options.claudeEnv);
    const referenceDir = this.canReadFiles(invocation.tool)
      ? invocation.referenceDir
      : undefined;
    try {
      return await runProcess(
        this.options.dockerBin,
        dockerRunArgs(this.options, { ...invocation, referenceDir }, name),
        {
          cwd: process.cwd(),
          input: invocation.input,
          timeoutMs: invocation.timeoutMs,
          signal: invocation.signal,
          env,
          onStdoutLine: invocation.onOutputLine,
        }
      );
    } catch (err) {
      // docker CLI 가 강제 종료되면 컨테이너가 남을 수 있어 정리한다.
      await runProcess(this.options.dockerBin, ["rm", "-f", name], {
        cwd: process.cwd(),
        input: "",
        timeoutMs: 15_000,
      }).catch(() => undefined);
      throw err;
    }
  }

  async verify(): Promise<string[]> {
    const { dockerBin, image, network } = this.options;
    const docker = (args: string[]) =>
      runProcess(dockerBin, args, { cwd: process.cwd(), input: "", timeoutMs: 15_000 });
    const problems: string[] = [];

    try {
      await docker(["version", "--format", "{{.Server.Version}}"]);
    } catch (err) {
      return [`docker 데몬에 연결할 수 없습니다: ${(err as Error).message}`];
    }
    await docker(["image", "inspect", image]).catch(() =>
      problems.push(`샌드박스 이미지 ${image} 가 없습니다. (pnpm sandbox:build)`)
    );
    try {
      const { stdout } = await docker([
        "network",
        "inspect",
        network,
        "--format",
        "{{.Internal}}",
      ]);
      if (stdout.trim() !== "true") {
        problems.push(
          `네트워크 ${network} 가 internal 이 아닙니다. 외부로 직접 나갈 수 있습니다.`
        );
      }
    } catch {
      problems.push(`샌드박스 네트워크 ${network} 가 없습니다. (pnpm sandbox:up)`);
    }
    const { stdout: proxies } = await docker([
      "ps",
      "--filter",
      `network=${network}`,
      "--filter",
      "name=egress-proxy",
      "--format",
      "{{.Names}}",
    ]).catch(() => ({ stdout: "" }));
    if (!proxies.trim()) {
      problems.push("egress 프록시가 실행 중이 아닙니다. (pnpm sandbox:up)");
    }
    for (const service of this.options.requiredServices ?? []) {
      const { stdout } = await docker([
        "ps",
        "--filter",
        `network=${network}`,
        "--filter",
        `name=${service}`,
        "--format",
        "{{.Names}}",
      ]).catch(() => ({ stdout: "" }));
      if (!stdout.trim())
        problems.push(`${service} 가 실행 중이 아닙니다. (pnpm sandbox:ops-up)`);
    }
    return problems;
  }
}
