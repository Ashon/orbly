import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HistoryReader } from "../src/history/reader.js";
import { handleLocalApi } from "../src/local-api.js";
import {
  BotAlreadyRunningError,
  BotStatusFile,
  readRunningBot,
  STATUS_FILE,
} from "../src/runtime/status.js";
import {
  applyLegacyEnv,
  botLockDirs,
  defaultHome,
  envValue,
  legacyHomeWarning,
  warnOnce,
} from "../src/settings/legacy.js";
import { loadEnv } from "../src/settings/load-env.js";
import { orblyHome } from "../src/settings/paths.js";
import { jobEnv } from "../src/tools/sandbox-job.js";

const root = mkdtempSync(path.join(tmpdir(), "orbly-legacy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A home folder with the given dot folders in it */
function homeWith(...dirs: string[]): string {
  const home = mkdtempSync(path.join(root, "home-"));
  for (const dir of dirs) mkdirSync(path.join(home, dir));
  return home;
}

describe("names from before the rename (Verda)", () => {
  it("reads VERDA_* as ORBLY_* unless ORBLY_* is set, with a message per old name", () => {
    const env: NodeJS.ProcessEnv = {
      VERDA_DATA_DIR: "/data/old",
      VERDA_DESKTOP_THEME: "dark",
      ORBLY_DESKTOP_THEME: "light",
      VERDA_EMPTY: " ",
    };
    const messages = applyLegacyEnv(env);
    expect(env.ORBLY_DATA_DIR).toBe("/data/old");
    expect(env.ORBLY_DESKTOP_THEME).toBe("light");
    expect(env.ORBLY_EMPTY).toBeUndefined();
    expect(messages).toEqual([
      "VERDA_DATA_DIR is deprecated and read as ORBLY_DATA_DIR. Rename it to ORBLY_DATA_DIR.",
      "VERDA_DESKTOP_THEME is deprecated and ORBLY_DESKTOP_THEME takes its place. Rename or remove VERDA_DESKTOP_THEME.",
    ]);
    expect(envValue({ VERDA_SANDBOX_DIR: "/old" }, "SANDBOX_DIR")).toBe("/old");
    expect(
      envValue({ ORBLY_SANDBOX_DIR: "/new", VERDA_SANDBOX_DIR: "/old" }, "SANDBOX_DIR")
    ).toBe("/new");
  });

  it("warns once per message", () => {
    const warn = vi.fn();
    warnOnce(["legacy test A", "legacy test B"], warn);
    warnOnce(["legacy test A"], warn);
    expect(warn.mock.calls).toEqual([["legacy test A"], ["legacy test B"]]);
  });

  it("uses ~/.verda only while ~/.orbly does not exist, and says how to move it", () => {
    const fresh = homeWith();
    expect(defaultHome(fresh)).toBe(path.join(fresh, ".orbly"));
    expect(legacyHomeWarning({}, fresh)).toBeUndefined();

    const old = homeWith(".verda");
    expect(defaultHome(old)).toBe(path.join(old, ".verda"));
    expect(orblyHome({}, old)).toBe(path.join(old, ".verda"));
    expect(legacyHomeWarning({}, old)).toMatch(/mv ~\/\.verda ~\/\.orbly/);
    // A location that is set is used as is, without the warning.
    expect(legacyHomeWarning({ ORBLY_HOME: "/srv/orbly" }, old)).toBeUndefined();

    const both = homeWith(".verda", ".orbly");
    expect(defaultHome(both)).toBe(path.join(both, ".orbly"));
  });

  it("reads VERDA_HOME when ORBLY_HOME is not set", () => {
    expect(orblyHome({ VERDA_HOME: "/srv/verda" }, "/home/me")).toBe("/srv/verda");
    expect(orblyHome({ VERDA_HOME: "/srv/verda", ORBLY_HOME: "~/o" }, "/home/me")).toBe(
      "/home/me/o"
    );
  });

  it("loads the settings file from the old home and maps its old keys", () => {
    const home = path.join(root, "load-env-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, ".env"),
      "VERDA_DATA_DIR=/data/from-file\nLOG_LEVEL=debug\nREASONER=codex\n"
    );
    const env: NodeJS.ProcessEnv = { VERDA_HOME: home, REASONER: "claude" };
    const warnings = loadEnv(env);
    expect(env).toMatchObject({
      ORBLY_HOME: home,
      ORBLY_DATA_DIR: "/data/from-file",
      LOG_LEVEL: "debug",
      // The existing environment wins over the file, as with node --env-file.
      REASONER: "claude",
    });
    expect(warnings).toContain(
      "VERDA_HOME is deprecated and read as ORBLY_HOME. Rename it to ORBLY_HOME."
    );
    expect(warnings).toContain(
      "VERDA_DATA_DIR is deprecated and read as ORBLY_DATA_DIR. Rename it to ORBLY_DATA_DIR."
    );
  });

  it("passes compose the resolved home and the mapped keys", () => {
    const home = homeWith(".verda");
    const envFile = path.join(home, ".verda", ".env");
    writeFileSync(envFile, "VERDA_SANDBOX_DIR=/old/sandbox\nOPS_TOOLS=on\n");
    const warn = vi.fn();
    const env = jobEnv({ HOME: home }, envFile, warn);
    expect(env).toMatchObject({
      ORBLY_HOME: path.join(home, ".verda"),
      ORBLY_SANDBOX_DIR: "/old/sandbox",
      OPS_TOOLS: "on",
    });
    expect(warn.mock.calls.map(([message]) => message as string).join("\n")).toMatch(
      /mv ~\/\.verda ~\/\.orbly[\s\S]*VERDA_SANDBOX_DIR is deprecated/
    );
  });

  it("sees a bot running from the other home, so old and new never connect together", async () => {
    const home = homeWith(".verda", ".orbly");
    const legacy = path.join(home, ".verda");
    const fresh = path.join(home, ".orbly");
    expect(botLockDirs(fresh, home)).toEqual([fresh, legacy]);
    expect(botLockDirs("/data/custom", home)).toEqual(["/data/custom", fresh, legacy]);

    // The parent process stands in for an old Verda bot that is still running.
    writeFileSync(
      path.join(legacy, STATUS_FILE),
      JSON.stringify({ version: 1, pid: process.ppid, managedBy: "desktop" })
    );
    expect(readRunningBot([fresh, legacy])).toMatchObject({
      alive: true,
      status: { pid: process.ppid },
    });
    await expect(
      BotStatusFile.acquire(fresh, "terminal", 0, [legacy])
    ).rejects.toBeInstanceOf(BotAlreadyRunningError);
  });

  it("shows run history written by Verda", async () => {
    const dataDir = path.join(homeWith(".verda"), ".verda");
    const runDir = path.join(dataDir, "runs", "2026-10-09", "20261009-084701-54e64d");
    mkdirSync(runDir, { recursive: true });
    // A record as Verda v0.1.x wrote it
    writeFileSync(
      path.join(runDir, "run.json"),
      JSON.stringify({
        version: 1,
        id: "20261009-084701-54e64d",
        status: "succeeded",
        attempts: 1,
        startedAt: "2026-10-08T23:47:01.716Z",
        updatedAt: "2026-10-08T23:47:31.716Z",
        slack: {
          channel: "C03",
          channelLabel: "#ops",
          threadTs: "1",
          eventTs: "1",
          placeholderTs: "1",
          userId: "U03",
          userName: "alice",
        },
        request: "Why did the nightly backup job fail?",
        backend: { reasoner: "claude", sandbox: "docker", model: "claude-opus-5-5" },
        context: { messages: 0 },
        attachments: [],
        events: [
          { kind: "message", at: "2026-10-08T23:47:01.716Z", text: "Checked it." },
        ],
        outputs: [],
        answer: "The backup volume was full.",
        finishedAt: "2026-10-08T23:47:31.716Z",
        durationMs: 30_000,
      })
    );
    const reader = new HistoryReader(dataDir);
    const get = async (pathname: string) =>
      (await handleLocalApi(reader, "GET", new URL(pathname, "orbly://app"))).json();
    expect(await get("/api/runs")).toMatchObject([
      { id: "20261009-084701-54e64d", status: "succeeded", reasoner: "claude@docker" },
    ]);
    expect(await get("/api/runs/20261009-084701-54e64d")).toMatchObject({
      request: "Why did the nightly backup job fail?",
      answer: "The backup volume was full.",
    });
  });
});
