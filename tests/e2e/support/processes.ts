import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "../../..");
/** tsx as a loader in the same process (the tsx CLI would run the bot in a child that SIGKILL does not reach) */
const FROM_SOURCE = ["--import", "tsx"];

/**
 * The bot or the hub as its own process, as it runs for real. Runs from source with tsx; E2E_BOT=bundle runs the
 * bot's bundle (build/bot/index.mjs, what the packaged app ships) after `pnpm bundle`.
 */
export class ManagedProcess {
  output = "";
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.child = spawn(command, args, {
      cwd: REPO,
      // Only what the test passes, so the developer's own ORBLY_* settings never leak in. Under c8
      // (pnpm test:e2e:coverage) the process also writes its coverage where c8 collects it.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.NODE_V8_COVERAGE
          ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
          : {}),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      this.output += chunk.toString("utf8");
      if (process.env.E2E_VERBOSE) process.stderr.write(chunk);
    };
    this.child.stdout!.on("data", collect);
    this.child.stderr!.on("data", collect);
    this.exited = new Promise((resolve) =>
      this.child.on("exit", (code, signal) => resolve({ code, signal }))
    );
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Waits for a line of output matching the pattern, counting from the start */
  async waitFor(pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(this.output);
      if (match) return match;
      if (!this.running) throw new Error(`Exited before ${pattern}:\n${this.output}`);
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${pattern}:\n${this.output}`);
      await sleep(50);
    }
  }

  /** SIGTERM, as the desktop app and Ctrl+C stop it, then waits for the exit */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.child.kill("SIGTERM");
    await this.exited;
  }

  /** SIGKILL, as a crash or a power loss: nothing gets to clean up */
  async kill(): Promise<void> {
    if (!this.running) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

export function startBot(env: Record<string, string>): ManagedProcess {
  return process.env.E2E_BOT === "bundle"
    ? new ManagedProcess(process.execPath, [path.join(REPO, "build/bot/index.mjs")], env)
    : new ManagedProcess(
        process.execPath,
        [...FROM_SOURCE, path.join(REPO, "src/index.ts")],
        env
      );
}

export function startHub(env: Record<string, string>): ManagedProcess {
  return new ManagedProcess(
    process.execPath,
    [...FROM_SOURCE, path.join(REPO, "src/hub/index.ts")],
    env
  );
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the check returns a value (not undefined or false) */
export async function eventually<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
