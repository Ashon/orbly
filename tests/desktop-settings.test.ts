import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsStore } from "../apps/desktop/src/settings.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-desktop-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = `# 개인 설정
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

describe("설정 저장소", () => {
  it("비밀 값은 가리고, 다루지 않는 항목과 환경 변수 우선 항목을 알려 준다", () => {
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

  it("봇과 같은 규칙으로 검증하고, 모르는 항목과 비울 수 없는 값은 받지 않는다", () => {
    const { store: s } = store();
    expect(s.validate({ MENTION_CONCURRENCY: "3" })).toEqual([]);
    expect(s.validate({ MENTION_CONCURRENCY: "0" })).toEqual([
      expect.objectContaining({ key: "MENTION_CONCURRENCY" }),
    ]);
    expect(s.validate({ OPS_TOOLS: "on" })).toEqual([
      expect.objectContaining({ key: "OPS_TOOLS" }),
    ]);
    expect(s.validate({ LLM_API_KEY: "x" })).toEqual([
      { key: "LLM_API_KEY", message: "설정 화면에서 바꿀 수 없는 항목입니다." },
    ]);
    expect(s.validate({ SLACK_BOT_TOKEN: " " })).toEqual([
      { key: "SLACK_BOT_TOKEN", message: "비워 둘 수 없습니다." },
    ]);
    expect(s.validate("bad")).toEqual([
      { message: "변경 내용 형식이 올바르지 않습니다." },
    ]);
  });

  it("저장하면 바뀐 값만 고치고 나머지는 그대로 둔다. 검증에 실패하면 쓰지 않는다", () => {
    const { envFile, store: s } = store();
    expect(
      s.save({ SLACK_BOT_TOKEN: "xoxb-9999-new", REASONER: null, TIMEZONE: "UTC" })
    ).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(`# 개인 설정
LLM_API_URL=https://llm.example.com
LLM_API_KEY=keep-me

SLACK_BOT_TOKEN=xoxb-9999-new
SLACK_APP_TOKEN=xapp-1-A0APP-3333-wxyz
REASONER=

# Verda 앱 설정 화면에서 추가
TIMEZONE=UTC
`);
    const before = readFileSync(envFile, "utf8");
    expect(s.save({ MENTION_CONCURRENCY: "-1" })).not.toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("앱의 환경 변수가 .env 보다 우선하는 것까지 반영해 검증한다", () => {
    const { store: s } = store({
      REASONER_SANDBOX: "docker",
      MENTION_ALLOWED_USERS: "U1",
    });
    // claude + docker 는 샌드박스 토큰이 있어야 한다.
    expect(s.validate({})).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("SANDBOX_CLAUDE_OAUTH_TOKEN"),
      }),
    ]);
    expect(s.validate({ SANDBOX_CLAUDE_OAUTH_TOKEN: "sk-ant-oat01-xxxx" })).toEqual([]);
  });
});
