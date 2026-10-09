import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Environment variables for the child process. Defaults to the current process environment */
  env?: NodeJS.ProcessEnv;
  /** Receives stdout line by line. (for JSONL event streams) */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** Non-zero exit code. Carries the output so callers can interpret the cause for their output format. */
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

/** Runs a CLI and passes input through stdin. Kills the process on timeout or abort. */
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
      () => kill(`${command} timed out (${Math.round(options.timeoutMs / 1000)}s)`),
      options.timeoutMs
    );
    const onAbort = () => kill(`${command} run was aborted.`);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (options.onStdoutLine) {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onStdoutLine(line);
      }
      if (stdout.length > MAX_OUTPUT_BYTES) kill(`${command} output is too large.`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${command} executable not found. Check PATH or the *_BIN setting.`
          : err.message;
      finish(new Error(hint));
    });
    child.on("close", (code) => {
      if (options.onStdoutLine && pending.trim()) options.onStdoutLine(pending);
      if (code === 0) {
        finish();
        return;
      }
      // claude -p writes failure details to stdout (JSON), so stdout is used when stderr is empty.
      const tail = (stderr.trim() || stdout.trim())
        .split("\n")
        .slice(-5)
        .join("\n")
        .slice(-500);
      finish(
        new ProcessExitError(
          `${command} exited with code ${code}${tail ? `: ${tail}` : ""}`,
          code,
          stdout,
          stderr
        )
      );
    });

    child.stdin.on("error", () => {
      // The process exited before reading all input. Handled in the close event.
    });
    child.stdin.end(options.input);
  });
}
