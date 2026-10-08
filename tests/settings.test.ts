import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkConfig, EnvSchema } from "../src/config.js";
import { BrokerEnvSchema } from "../src/sandbox/env.js";
import {
  envKeys,
  formatEnvValue,
  readEnvFile,
  readEnvValues,
  updateEnvText,
  writeEnvFile,
} from "../src/settings/env-file.js";
import { maskSecret, SETTING_FIELDS } from "../src/settings/fields.js";
import { checkSlackTokens } from "../src/slack/check.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = `# 개인 LLM 설정
LLM_API_URL=https://llm.example.com
LLM_API_KEY=secret-value

# ---- Slack ----
SLACK_BOT_TOKEN=xoxb-old
SLACK_APP_TOKEN=xapp-1-A1-old
REASONER=codex
REASONER=claude
LOG_LEVEL=info
`;

describe(".env 편집", () => {
  it("값만 바꾸고 주석, 순서, 다루지 않는 항목은 그대로 둔다", () => {
    const next = updateEnvText(ENV, {
      SLACK_BOT_TOKEN: "xoxb-new",
      REASONER: "codex",
      LOG_LEVEL: null,
      MENTION_ALLOWED_USERS: "U1, U2",
    });
    expect(next).toBe(`# 개인 LLM 설정
LLM_API_URL=https://llm.example.com
LLM_API_KEY=secret-value

# ---- Slack ----
SLACK_BOT_TOKEN=xoxb-new
SLACK_APP_TOKEN=xapp-1-A1-old
REASONER=codex
LOG_LEVEL=

# Verda 앱 설정 화면에서 추가
MENTION_ALLOWED_USERS='U1, U2'
`);
    expect(readEnvValues(next)).toMatchObject({
      LLM_API_KEY: "secret-value",
      REASONER: "codex",
      LOG_LEVEL: "",
      MENTION_ALLOWED_USERS: "U1, U2",
    });
    expect(envKeys(next)).toContain("LLM_API_URL");
    expect(updateEnvText("", { A: "1" })).toBe("# Verda 앱 설정 화면에서 추가\nA=1\n");
  });

  it("특수 문자는 따옴표로 감싸고 node 와 같은 값으로 읽힌다", () => {
    for (const value of [
      'a "b" c',
      "x#y",
      "back\\slash",
      "~/.codex/auth.json",
      "Asia/Seoul",
    ]) {
      expect(readEnvValues(`K=${formatEnvValue(value)}\n`).K).toBe(value);
    }
    expect(formatEnvValue("xoxb-1-abc")).toBe("xoxb-1-abc");
    expect(formatEnvValue("~/.codex/auth.json")).toBe("~/.codex/auth.json");
    expect(() => formatEnvValue("a\nb")).toThrow(/줄바꿈/);
  });

  it("기존 권한을 지키고 새 파일은 600 으로 쓴다", () => {
    const file = path.join(root, ".env");
    writeEnvFile(file, "A=1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "A=1\n", { mode: 0o640 });
    writeEnvFile(file, "A=2\n");
    expect(readEnvFile(file)).toBe("A=2\n");
    expect(readEnvFile(path.join(root, "missing"))).toBe("");
  });
});

describe("설정 항목", () => {
  it("모든 항목이 봇 또는 broker 설정에 있고 기본값이 같다", () => {
    const tokens = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };
    const botDefaults = EnvSchema.parse(tokens) as Record<string, unknown>;
    const brokerDefaults = BrokerEnvSchema.parse({}) as Record<string, unknown>;
    for (const field of SETTING_FIELDS) {
      const inBot = field.key in EnvSchema.shape;
      const inBroker = field.key in BrokerEnvSchema.shape;
      expect([field.key, inBot || inBroker]).toEqual([field.key, true]);
      // broker 가 읽는 값은 broker 를 다시 띄워야 적용된다.
      expect([field.key, field.applies === "broker"]).toEqual([field.key, inBroker]);
      if (field.required) continue;
      const value = (inBot ? botDefaults : brokerDefaults)[field.key];
      // 쉼표 목록은 비어 있으면 [] 로 읽힌다.
      const unset = value === undefined || (Array.isArray(value) && value.length === 0);
      expect([field.key, unset ? undefined : String(value)]).toEqual([
        field.key,
        field.default,
      ]);
    }
  });

  it("비밀 값은 접두어와 끝 4자리만 보여 준다", () => {
    expect(maskSecret("xoxb-1234-5678-abcd")).toBe("xoxb-...abcd");
    expect(maskSecret("xapp-1-A1-zzzz9999")).toBe("xapp-...9999");
  });

  it("검증 문제를 환경 변수별로 돌려준다", () => {
    const base = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };
    expect(checkConfig(base)).toEqual([]);
    expect(
      checkConfig({ ...base, SLACK_BOT_TOKEN: "xoxp-1", MENTION_CONCURRENCY: "0" })
    ).toEqual([
      { key: "SLACK_BOT_TOKEN", message: "xoxb- 로 시작하는 봇 토큰이어야 합니다" },
      expect.objectContaining({ key: "MENTION_CONCURRENCY" }),
    ]);
    expect(
      checkConfig({ ...base, OPS_TOOLS: "on", MENTION_ALLOWED_USERS: "U1" })
    ).toEqual([
      { key: "OPS_TOOLS", message: expect.stringContaining("REASONER_SANDBOX=docker") },
    ]);
  });
});

describe("연결 확인", () => {
  it("봇 토큰, 스코프, 같은 앱, Socket Mode 를 확인한다", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      calls.push(`${method} ${(init?.headers as Record<string, string>).Authorization}`);
      const bodies: Record<string, object> = {
        "auth.test": { ok: true, user: "verda", user_id: "U0V", team: "T", bot_id: "B1" },
        "bots.info": { ok: true, bot: { app_id: "A0APP" } },
        "apps.connections.open": { ok: true, url: "wss://example/?ticket=t" },
      };
      return new Response(JSON.stringify(bodies[method]), {
        headers: { "x-oauth-scopes": "app_mentions:read,channels:history,chat:write" },
      });
    }) as typeof fetch;
    const items = await checkSlackTokens(
      { botToken: "xoxb-1", appToken: "xapp-1-A0APP-zz" },
      fetchImpl
    );
    expect(items).toEqual([
      { label: "봇 토큰", ok: true, detail: "verda (U0V) @ T" },
      {
        label: "봇 스코프",
        ok: false,
        detail: "없음: channels:read, files:read, files:write, users:read",
      },
      { label: "같은 앱", ok: true, detail: "봇=A0APP, 앱 토큰=A0APP" },
      { label: "Socket Mode", ok: true, detail: "접속 주소 발급됨 (연결은 하지 않음)" },
    ]);
    expect(calls).toEqual([
      "auth.test Bearer xoxb-1",
      "bots.info Bearer xoxb-1",
      "apps.connections.open Bearer xapp-1-A0APP-zz",
    ]);
    expect(await checkSlackTokens({ botToken: "xoxb-1" })).toEqual([
      expect.objectContaining({ ok: false, label: "토큰" }),
    ]);
  });
});
