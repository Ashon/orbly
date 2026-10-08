import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { redactLogLine } from "../../../src/logger.js";
import { readBotStatus } from "../../../src/runtime/status.js";
import {
  checkAllowlist,
  readAllowlistFile,
  updateAllowlist,
  writeAllowlistFile,
  type AllowlistIssue,
} from "../../../src/sandbox/allowlist.js";
import { collectSandboxStatus, commandRunner } from "../../../src/sandbox/status.js";
import {
  SANDBOX_JOBS,
  type SandboxJob,
  type SandboxJobKind,
  type SandboxStatus,
} from "../../../src/sandbox/types.js";
import { readEnvFile, readEnvValues } from "../../../src/settings/env-file.js";

const OUTPUT_LINES = 400;
/** 터미널 색 코드 (docker, pnpm 출력) */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * 설정 화면의 샌드박스 영역. 상태를 모으고, 허용 도메인 목록을 고치고, 적용 작업(pnpm 스크립트)을 실행한다.
 * 작업은 한 번에 하나만 돌고, 출력은 비밀 값을 가린 뒤 화면으로 보낸다.
 * 프록시와 broker 를 다시 띄우면 진행 중인 도구 호출이 끊기므로 처리 중인 요청이 있으면 막는다.
 */
export class SandboxService extends EventEmitter<{ job: [SandboxJob] }> {
  private current?: SandboxJob;

  constructor(
    private readonly options: {
      repoRoot: string;
      /** 설정 파일 (저장소 밖, src/settings/paths.ts) */
      envFile: string;
      dataDir: string;
      env: NodeJS.ProcessEnv;
      toolPath: () => string;
    }
  ) {
    super();
  }

  get job(): SandboxJob | undefined {
    return this.current;
  }

  private get commandEnv(): NodeJS.ProcessEnv {
    return { ...this.options.env, PATH: this.options.toolPath() };
  }

  status(): Promise<SandboxStatus> {
    return collectSandboxStatus({
      repoRoot: this.options.repoRoot,
      envFile: this.options.envFile,
      dataDir: this.options.dataDir,
      env: this.options.env,
      run: commandRunner(this.commandEnv, this.options.repoRoot),
    });
  }

  saveAllowlist(raw: unknown): AllowlistIssue[] {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      return [{ message: "도메인 목록 형식이 올바르지 않습니다." }];
    }
    const values = {
      ...readEnvValues(readEnvFile(this.options.envFile)),
      ...this.options.env,
    };
    const issues = checkAllowlist(
      raw as string[],
      values.REASONER === "codex" ? "codex" : "claude"
    );
    if (issues.length > 0) return issues;
    const file = path.join(this.options.repoRoot, "sandbox/proxy/allowed-domains.txt");
    writeAllowlistFile(file, updateAllowlist(readAllowlistFile(file), raw as string[]));
    return [];
  }

  run(kind: unknown): { job?: SandboxJob; error?: string } {
    if (typeof kind !== "string" || !(kind in SANDBOX_JOBS))
      return { error: "알 수 없는 작업입니다." };
    const jobKind = kind as SandboxJobKind;
    if (this.current?.state === "running") {
      return { error: `${SANDBOX_JOBS[this.current.kind].label} 작업이 진행 중입니다.` };
    }
    if (jobKind === "proxy" || jobKind === "broker") {
      const bot = readBotStatus(this.options.dataDir);
      const active = bot.alive ? (bot.status?.requests.active ?? 0) : 0;
      if (active > 0) {
        return {
          error: `처리 중인 요청 ${active}건이 끝난 뒤 다시 시도하세요. (진행 중인 도구 호출이 끊깁니다)`,
        };
      }
    }
    const job: SandboxJob = {
      kind: jobKind,
      state: "running",
      startedAt: new Date().toISOString(),
      output: [`$ pnpm ${SANDBOX_JOBS[jobKind].script}`],
    };
    this.current = job;
    this.emit("job", { ...job });

    const child = spawn("pnpm", ["-s", "run", SANDBOX_JOBS[jobKind].script], {
      cwd: this.options.repoRoot,
      env: this.commandEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pendingEmit: NodeJS.Timeout | undefined;
    const flush = () => {
      pendingEmit = undefined;
      this.emit("job", { ...job, output: [...job.output] });
    };
    const capture = (chunk: Buffer) => {
      const lines = chunk
        .toString()
        .split(/\r?\n/)
        .map((line) => redactLogLine(line.replace(ANSI_ESCAPE, "")))
        .filter((line) => line.trim());
      job.output = [...job.output, ...lines].slice(-OUTPUT_LINES);
      pendingEmit ??= setTimeout(flush, 200);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (err) => {
      job.output.push(`실행 실패: ${err.message}`);
    });
    child.on("close", (code) => {
      if (pendingEmit) clearTimeout(pendingEmit);
      job.state = code === 0 ? "succeeded" : "failed";
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      this.emit("job", { ...job, output: [...job.output] });
    });
    return { job: { ...job } };
  }
}
