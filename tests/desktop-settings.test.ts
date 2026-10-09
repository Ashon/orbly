import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsStore } from "../apps/desktop/src/settings.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-desktop-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = `# Personal settings
LLM_API_URL=https://llm.example.com
LLM_API_KEY=keep-me

SLACK_BOT_TOKEN=xoxb-1111-2222-abcd
SLACK_APP_TOKEN=xapp-1-A0APP-3333-wxyz
REASONER=claude
`;

function store(env: NodeJS.ProcessEnv = {}) {
  const envFile = path.join(root, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(envFile, ENV, { mode: 0o600 });
  return { envFile, store: new SettingsStore({ envFile, dataDir: "/tmp/verda", env }) };
}

describe("settings store", () => {
  it("masks secrets and reports unhandled entries and environment overrides", () => {
    const { store: s } = store({ LOG_LEVEL: "debug" });
    const view = s.view();
    expect(view.secrets.SLACK_BOT_TOKEN).toEqual({ set: true, hint: "xoxb-...abcd" });
    expect(view.secrets.SANDBOX_CLAUDE_OAUTH_TOKEN).toEqual({ set: false });
    expect(JSON.stringify(view)).not.toContain("xoxb-1111");
    expect(view.values.REASONER).toBe("claude");
    expect(view.values.LOG_LEVEL).toBe("");
    expect(view.otherKeys).toEqual(["LLM_API_URL", "LLM_API_KEY"]);
    expect(view.overridden).toEqual(["LOG_LEVEL"]);
  });

  it("validates with the bot rules and rejects unknown entries and required empty values", () => {
    const { store: s } = store();
    expect(s.validate({ MENTION_CONCURRENCY: "3" })).toEqual([]);
    expect(s.validate({ MENTION_CONCURRENCY: "0" })).toEqual([
      expect.objectContaining({ key: "MENTION_CONCURRENCY" }),
    ]);
    expect(s.validate({ OPS_TOOLS: "on" })).toEqual([
      expect.objectContaining({ key: "OPS_TOOLS" }),
    ]);
    expect(s.validate({ LLM_API_KEY: "x" })).toEqual([
      {
        key: "LLM_API_KEY",
        message: "This entry cannot be changed from the Settings screen.",
      },
    ]);
    expect(s.validate({ SLACK_BOT_TOKEN: " " })).toEqual([
      { key: "SLACK_BOT_TOKEN", message: "Cannot be empty." },
    ]);
    expect(s.validate("bad")).toEqual([{ message: "The changes format is invalid." }]);
  });

  it("saves only changed values and keeps the rest; writes nothing when validation fails", () => {
    const { envFile, store: s } = store();
    expect(
      s.save({ SLACK_BOT_TOKEN: "xoxb-9999-new", REASONER: null, TIMEZONE: "UTC" })
    ).toEqual([]);
    expect(readFileSync(envFile, "utf8").replace(/^# .*\n(?=TIMEZONE=)/m, "# <added>\n"))
      .toBe(`# Personal settings
LLM_API_URL=https://llm.example.com
LLM_API_KEY=keep-me

SLACK_BOT_TOKEN=xoxb-9999-new
SLACK_APP_TOKEN=xapp-1-A0APP-3333-wxyz
REASONER=

# <added>
TIMEZONE=UTC
`);
    const before = readFileSync(envFile, "utf8");
    expect(s.save({ MENTION_CONCURRENCY: "-1" })).not.toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("validates with app environment variables taking precedence over .env", () => {
    const { store: s } = store({
      REASONER_SANDBOX: "docker",
      MENTION_ALLOWED_USERS: "U1",
    });
    // claude + docker requires a sandbox token.
    expect(s.validate({})).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("SANDBOX_CLAUDE_OAUTH_TOKEN"),
      }),
    ]);
    expect(s.validate({ SANDBOX_CLAUDE_OAUTH_TOKEN: "sk-ant-oat01-xxxx" })).toEqual([]);
  });
});
