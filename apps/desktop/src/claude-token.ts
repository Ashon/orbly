import { type ChildProcess, spawn } from "node:child_process";
import type { SettingsIssue } from "../../../src/settings/fields.js";

/** setup-token waits for the browser approval; past this the run is given up. */
const TIMEOUT_MS = 5 * 60_000;
/** A long-lived Claude Code OAuth token, as claude setup-token prints it */
const TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;

export type ClaudeTokenResult = { ok: true } | { ok: false; error: string };

/** Terminal output without color codes, cursor moves and carriage returns */
export function plainText(output: string): string {
  /* eslint-disable no-control-regex -- terminal escape sequences are control characters by definition */
  return output
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
  /* eslint-enable no-control-regex */
}

/** The token in setup-token's output, if it has printed one */
export function findClaudeToken(output: string): string | undefined {
  return TOKEN.exec(plainText(output))?.[0];
}

/**
 * Runs `claude setup-token` for the Settings screen and saves the token it prints as SANDBOX_CLAUDE_OAUTH_TOKEN,
 * so a Pro or Max subscriber does not copy it by hand. The command draws a terminal UI and prints nothing without
 * a terminal, so it runs under macOS's script(1), which gives it a pseudo-terminal (wide enough that the token is
 * not wrapped). The browser approval is the user's; the token goes from the command's output straight to .env and
 * is never sent to the UI.
 */
export class ClaudeTokenSetup {
  private child?: ChildProcess;
  private cancelled = false;

  constructor(
    private readonly options: {
      /** PATH from the login shell, so claude is found when the app starts from Finder */
      toolPath: () => string;
      save: (token: string) => SettingsIssue[];
      platform?: NodeJS.Platform;
      /** For tests: the command in place of script(1) running claude setup-token */
      command?: [string, string[]];
    }
  ) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  run(): Promise<ClaudeTokenResult> {
    if ((this.options.platform ?? process.platform) !== "darwin")
      return Promise.resolve({
        ok: false,
        error: "Run claude setup-token in a terminal and paste the token here.",
      });
    if (this.child)
      return Promise.resolve({
        ok: false,
        error: "Getting a token is already in progress.",
      });

    this.cancelled = false;
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: ClaudeTokenResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child?.kill("SIGTERM");
        this.child = undefined;
        resolve(result);
      };
      const [command, args] = this.options.command ?? [
        "/usr/bin/script",
        [
          "-q",
          "/dev/null",
          "/bin/sh",
          "-c",
          "stty cols 1000 2>/dev/null; exec claude setup-token",
        ],
      ];
      const child = spawn(command, args, {
        env: { ...process.env, PATH: this.options.toolPath() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            error:
              "No approval within 5 minutes. Try again, or run claude setup-token in a terminal.",
          }),
        TIMEOUT_MS
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const token = findClaudeToken(output);
        if (!token) return;
        const issues = this.options.save(token);
        finish(
          issues.length > 0
            ? { ok: false, error: issues.map((issue) => issue.message).join(" ") }
            : { ok: true }
        );
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) =>
        finish({ ok: false, error: `Could not run claude setup-token: ${err.message}` })
      );
      child.on("close", (code) => {
        if (settled) return;
        if (this.cancelled) return finish({ ok: false, error: "Cancelled." });
        // Ended without a token: show the last line it printed (for example that a subscription is required).
        const last = plainText(output)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 3 && !/^[·✢✳✶✻✽*]+$/.test(line))
          .at(-1);
        finish({
          ok: false,
          error:
            code === 127
              ? "claude was not found. Install Claude Code, or run claude setup-token in a terminal."
              : `claude setup-token ended without a token${last ? `: ${last}` : "."}`,
        });
      });
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.child?.kill("SIGTERM");
  }
}
