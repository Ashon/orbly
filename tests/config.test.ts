import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dir = mkdtempSync(path.join(tmpdir(), "verda-ws-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };

describe("loadConfig", () => {
  it("기본값을 채운다", () => {
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
    expect(config.dataDir).toBe(path.join(homedir(), ".verda"));
    expect(config.history).toEqual({ retentionDays: 30 });
    expect(loadConfig({ ...env, HISTORY: "off" }).history).toBeUndefined();
    expect(
      loadConfig({ ...env, GENERATED_IMAGE_MAX_PX: "0" }).render.generatedMaxPx
    ).toBe(0);
  });

  it("빈 값은 설정하지 않은 것으로 본다", () => {
    const config = loadConfig({ ...env, MENTION_WORKSPACE: "", REASONER_MODEL: " " });
    expect(config.mention.workspace).toBeUndefined();
    expect(config.reasoner.model).toBe("claude-opus-5-5");
  });

  it("허용 사용자 ID 목록을 정규화하고 검증한다", () => {
    const config = loadConfig({ ...env, MENTION_ALLOWED_USERS: "u0boss, W0TEAM,U0BOSS" });
    expect(config.mention.allowedUserIds).toEqual(["U0BOSS", "W0TEAM"]);
    expect(() => loadConfig({ ...env, MENTION_ALLOWED_USERS: "@bob" })).toThrow(
      /MENTION_ALLOWED_USERS/
    );
  });

  it("참고 디렉터리는 존재하는 절대 경로여야 한다", () => {
    expect(loadConfig({ ...env, MENTION_WORKSPACE: dir }).mention.workspace).toBe(dir);
    expect(() => loadConfig({ ...env, MENTION_WORKSPACE: "./x" })).toThrow(
      /MENTION_WORKSPACE/
    );
    expect(() => loadConfig({ ...env, MENTION_WORKSPACE: `${dir}/missing` })).toThrow(
      /MENTION_WORKSPACE/
    );
  });

  it("codex 는 모델을 지정하지 않으면 codex 설정을 따른다", () => {
    const config = loadConfig({ ...env, REASONER: "codex" });
    expect(config.reasoner.backend).toBe("codex");
    expect(config.reasoner.model).toBeUndefined();
  });

  it("ops 도구는 docker 샌드박스와 허용 사용자 목록이 있어야 켜진다", () => {
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

  it("토큰 형식이 틀리면 어떤 값이 문제인지 알려준다", () => {
    expect(() => loadConfig({ ...env, SLACK_BOT_TOKEN: "xoxp-1" })).toThrow(
      /SLACK_BOT_TOKEN/
    );
  });
});
