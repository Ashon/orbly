import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 자식 프로세스 환경 변수. 기본은 현재 프로세스 환경 */
  env?: NodeJS.ProcessEnv;
  /** stdout 을 줄 단위로 받는다. (JSONL 이벤트 스트림 처리용) */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** 0 이 아닌 종료 코드. 호출 측이 출력 형식에 맞게 원인을 해석할 수 있도록 출력을 담는다. */
export class ProcessExitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

/** CLI 를 실행하고 stdin 으로 입력을 넘긴다. 시간 초과/중단 시 프로세스를 종료한다. */
export function runProcess(
  command: string,
  args: string[],
  options: RunOptions
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    const kill = (reason: string) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish(new Error(reason));
    };

    const timer = setTimeout(
      () => kill(`${command} 응답 시간 초과 (${Math.round(options.timeoutMs / 1000)}s)`),
      options.timeoutMs
    );
    const onAbort = () => kill(`${command} 실행이 중단되었습니다.`);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (options.onStdoutLine) {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onStdoutLine(line);
      }
      if (stdout.length > MAX_OUTPUT_BYTES) kill(`${command} 출력이 너무 큽니다.`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${command} 실행 파일을 찾을 수 없습니다. PATH 또는 *_BIN 설정을 확인하세요.`
          : err.message;
      finish(new Error(hint));
    });
    child.on("close", (code) => {
      if (options.onStdoutLine && pending.trim()) options.onStdoutLine(pending);
      if (code === 0) {
        finish();
        return;
      }
      // claude -p 는 실패 내용을 stdout(JSON)으로 내보내므로 stderr 가 비면 stdout 을 쓴다.
      const tail = (stderr.trim() || stdout.trim())
        .split("\n")
        .slice(-5)
        .join("\n")
        .slice(-500);
      finish(
        new ProcessExitError(
          `${command} 종료 코드 ${code}${tail ? `: ${tail}` : ""}`,
          code,
          stdout,
          stderr
        )
      );
    });

    child.stdin.on("error", () => {
      // 프로세스가 입력을 다 읽기 전에 끝난 경우. close 이벤트에서 처리한다.
    });
    child.stdin.end(options.input);
  });
}
