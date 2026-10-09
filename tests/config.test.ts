import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkConfig, loadConfig } from "../src/config.js";
import { defaultHome } from "../src/settings/legacy.js";

const dir = mkdtempSync(path.join(tmpdir(), "orbly-ws-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };

describe("loadConfig", () => {
  it("fills in defaults", () => {
    const config = loadConfig(env);
    expect(config.reasoner).toMatchObject({
      backend: "claude",
      model: "claude-opus-5-5",
    });
    expect(config.reasoner.sandbox).toBeUndefined();
    expect(config.mention).toEqual({
      allowedUserIds: [],
      workspace: undefined,
      concurrency: 2,
    });
    expect(config.render).toMatchObject({ enabled: true, generatedMaxPx: 512 });
    // The default home: ~/.orbly, or ~/.verda before migrating (tests/legacy.test.ts)
    expect(config.dataDir).toBe(defaultHome());
    expect(config.history).toEqual({ retentionDays: 30 });
    expect(loadConfig({ ...env, HISTORY: "off" }).history).toBeUndefined();
    expect(
      loadConfig({ ...env, GENERATED_IMAGE_MAX_PX: "0" }).render.generatedMaxPx
    ).toBe(0);
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ ...env, MENTION_WORKSPACE: "", REASONER_MODEL: " " });
    expect(config.mention.workspace).toBeUndefined();
    expect(config.reasoner.model).toBe("claude-opus-5-5");
  });

  it("normalizes and validates the allowed user ID list", () => {
    const config = loadConfig({ ...env, MENTION_ALLOWED_USERS: "u0boss, W0TEAM,U0BOSS" });
    expect(config.mention.allowedUserIds).toEqual(["U0BOSS", "W0TEAM"]);
    expect(() => loadConfig({ ...env, MENTION_ALLOWED_USERS: "@bob" })).toThrow(
      /MENTION_ALLOWED_USERS/
    );
  });

  it("requires the reference directory to be an existing absolute path", () => {
    expect(loadConfig({ ...env, MENTION_WORKSPACE: dir }).mention.workspace).toBe(dir);
    expect(() => loadConfig({ ...env, MENTION_WORKSPACE: "./x" })).toThrow(
      /MENTION_WORKSPACE/
    );
    expect(() => loadConfig({ ...env, MENTION_WORKSPACE: `${dir}/missing` })).toThrow(
      /MENTION_WORKSPACE/
    );
  });

  it("uses the codex config for codex when no model is set", () => {
    const config = loadConfig({ ...env, REASONER: "codex" });
    expect(config.reasoner.backend).toBe("codex");
    expect(config.reasoner.model).toBeUndefined();
  });

  it("enables ops tools only with the docker sandbox and an allowed user list", () => {
    const codexAuth = path.join(dir, "auth.json");
    writeFileSync(codexAuth, "{}");
    const base = {
      ...env,
      REASONER: "codex",
      REASONER_MODEL: "m",
      SANDBOX_CODEX_AUTH_FILE: codexAuth,
      OPS_TOOLS: "on",
    };
    expect(() => loadConfig({ ...base, MENTION_ALLOWED_USERS: "U1" })).toThrow(
      /REASONER_SANDBOX=docker/
    );
    expect(() => loadConfig({ ...base, REASONER_SANDBOX: "docker" })).toThrow(
      /MENTION_ALLOWED_USERS/
    );
    const config = loadConfig({
      ...base,
      REASONER_SANDBOX: "docker",
      MENTION_ALLOWED_USERS: "U1",
    });
    expect(config.reasoner.mcpServers).toEqual([
      { name: "ops", url: "http://ops-broker:8080/mcp" },
    ]);
    expect(config.reasoner.sandbox).toMatchObject({
      noProxy: ["ops-broker"],
      requiredServices: ["ops-broker"],
    });
    expect(loadConfig(env).reasoner.mcpServers).toEqual([]);
  });

  it("reports which value is wrong when a token format is invalid", () => {
    expect(() => loadConfig({ ...env, SLACK_BOT_TOKEN: "xoxp-1" })).toThrow(
      /SLACK_BOT_TOKEN/
    );
  });
});

describe("Slack API URL", () => {
  it("defaults to slack.com and accepts https or a server on this computer", () => {
    const app = (extra: Record<string, string> = {}) => {
      const slack = loadConfig({ ...env, ...extra }).slack;
      return slack.kind === "app" ? slack.apiUrl : undefined;
    };
    expect(app()).toBe("https://slack.com/api/");
    expect(app({ SLACK_API_URL: "https://slack-gov.com/api" })).toBe(
      "https://slack-gov.com/api/"
    );
    expect(app({ SLACK_API_URL: "http://127.0.0.1:4100/api/" })).toBe(
      "http://127.0.0.1:4100/api/"
    );
    expect(() =>
      loadConfig({ ...env, SLACK_API_URL: "http://slack.example/api/" })
    ).toThrow(/SLACK_API_URL/);
  });
});

describe("checkConfig", () => {
  it("marks settings that are only missing, and still checks the rules behind them", () => {
    expect(
      checkConfig({ REASONER_SANDBOX: "docker", OPS_TOOLS: "on" }).map(
        ({ key, missing }) => ({
          key,
          missing,
        })
      )
    ).toEqual([
      { key: "SLACK_BOT_TOKEN", missing: true },
      { key: "SLACK_APP_TOKEN", missing: true },
      { key: "OPS_TOOLS", missing: undefined },
    ]);
    expect(checkConfig({ ...env, REASONER_SANDBOX: "docker" })).toEqual([
      expect.objectContaining({ key: "SANDBOX_CLAUDE_OAUTH_TOKEN", missing: true }),
    ]);
  });

  it("does not mark a wrong value as missing", () => {
    expect(checkConfig({ ...env, SLACK_BOT_TOKEN: "xoxp-1" })).toEqual([
      expect.not.objectContaining({ missing: true }),
    ]);
  });
});
