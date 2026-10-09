import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { redactLogLine } from "../../../src/logger.js";
import { readBotStatus } from "../../../src/runtime/status.js";
import {
  checkAllowlist,
  ensureAllowlistFile,
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
import { allowlistPath } from "../../../src/settings/paths.js";

const OUTPUT_LINES = 400;
/** Terminal color codes (docker output) */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * Sandbox section of the Settings screen. Collects status, edits the allowed domain list, and runs apply jobs.
 * Jobs run the src/tools/sandbox-job.ts bundle with the app's Node (ELECTRON_RUN_AS_NODE). No repository or pnpm is needed.
 * Only one job runs at a time, and its output is sent to the UI with secrets masked.
 * Restarting the proxy or broker cuts off tool calls in progress, so it is blocked while requests are active.
 */
export class SandboxService extends EventEmitter<{ job: [SandboxJob] }> {
  private current?: SandboxJob;

  constructor(
    private readonly options: {
      /** Directory containing sandbox/compose.yaml (app-paths.ts) */
      sandboxDir: string;
      /** Sandbox apply job runner (app-paths.ts) */
      jobRunner: string;
      /** Settings file (outside the repository, src/settings/paths.ts) */
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
      sandboxDir: this.options.sandboxDir,
      envFile: this.options.envFile,
      dataDir: this.options.dataDir,
      env: this.options.env,
      run: commandRunner(this.commandEnv, this.options.dataDir),
    });
  }

  saveAllowlist(raw: unknown): AllowlistIssue[] {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      return [{ message: "The domain list format is invalid." }];
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
    const file = allowlistPath(this.options.env);
    ensureAllowlistFile(
      file,
      path.join(this.options.sandboxDir, "proxy/allowed-domains.txt")
    );
    writeAllowlistFile(file, updateAllowlist(readAllowlistFile(file), raw as string[]));
    return [];
  }

  run(kind: unknown): { job?: SandboxJob; error?: string } {
    if (typeof kind !== "string" || !(kind in SANDBOX_JOBS))
      return { error: "Unknown job." };
    const jobKind = kind as SandboxJobKind;
    if (this.current?.state === "running") {
      return {
        error: `A job is already in progress: ${SANDBOX_JOBS[this.current.kind].label}.`,
      };
    }
    if (jobKind === "proxy" || jobKind === "broker") {
      const bot = readBotStatus(this.options.dataDir);
      const active = bot.alive ? (bot.status?.requests.active ?? 0) : 0;
      if (active > 0) {
        return {
          error: `Try again after ${active} active ${active === 1 ? "request finishes" : "requests finish"}. (Tool calls in progress would be cut off)`,
        };
      }
    }
    if (!existsSync(this.options.jobRunner)) {
      return {
        error: `Job runner not found: ${this.options.jobRunner} (run pnpm bundle in the repository)`,
      };
    }
    const job: SandboxJob = {
      kind: jobKind,
      state: "running",
      startedAt: new Date().toISOString(),
      output: [`$ sandbox-job ${jobKind}`],
    };
    this.current = job;
    this.emit("job", { ...job });

    const child = spawn(process.execPath, [this.options.jobRunner, jobKind], {
      cwd: this.options.dataDir,
      env: {
        ...this.commandEnv,
        ELECTRON_RUN_AS_NODE: "1",
        VERDA_SANDBOX_DIR: this.options.sandboxDir,
      },
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
      job.output.push(`Failed to run: ${err.message}`);
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
