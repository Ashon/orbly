import { checkConfig } from "../../../src/config.js";
import { checkBrokerEnv } from "../../../src/sandbox/env.js";
import {
  envKeys,
  readEnvFile,
  readEnvValues,
  updateEnvText,
  writeEnvFile,
} from "../../../src/settings/env-file.js";
import {
  maskSecret,
  SETTING_FIELDS,
  type SettingsChanges,
  type SettingsIssue,
  type SettingsView,
} from "../../../src/settings/fields.js";
import { checkSlackTokens, type SlackCheckItem } from "../../../src/slack/check.js";

const FIELDS = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

/**
 * 설정 화면의 .env 읽기/쓰기. 저장소 밖의 설정 파일(src/settings/paths.ts, 기본 ~/.verda/.env)이
 * 봇(앱, 터미널 모두)의 단일 설정 원본이다.
 * - 비밀 값은 화면으로 보내지 않는다. (설정 여부와 끝 4자리만)
 * - 저장 전에 봇, broker 와 같은 규칙(checkConfig, checkBrokerEnv)으로 검증한다. 앱의 환경 변수가 .env 보다 우선하는 것도 같다.
 * - 설정 화면이 다루지 않는 항목, 주석, 순서는 그대로 둔다.
 */
export class SettingsStore {
  constructor(
    private readonly options: { envFile: string; dataDir: string; env: NodeJS.ProcessEnv }
  ) {}

  view(): SettingsView {
    const text = readEnvFile(this.options.envFile);
    const values = readEnvValues(text);
    const view: SettingsView = {
      envFile: this.options.envFile,
      exists: text !== "",
      dataDir: this.options.dataDir,
      values: {},
      secrets: {},
      overridden: [],
      otherKeys: envKeys(text).filter((key) => !FIELDS.has(key)),
    };
    for (const field of SETTING_FIELDS) {
      const value = values[field.key] ?? "";
      if (field.type === "secret") {
        view.secrets[field.key] = value
          ? { set: true, hint: maskSecret(value) }
          : { set: false };
      } else {
        view.values[field.key] = value;
      }
      if (this.options.env[field.key]?.trim()) view.overridden.push(field.key);
    }
    return view;
  }

  validate(raw: unknown): SettingsIssue[] {
    const parsed = this.parseChanges(raw);
    if ("issues" in parsed) return parsed.issues;
    return this.check(parsed.changes);
  }

  /** 봇 설정과 broker 설정을 함께 검증한다. */
  private check(changes: SettingsChanges): SettingsIssue[] {
    const env = { ...this.candidate(changes), ...this.options.env };
    return [...checkConfig(env), ...checkBrokerEnv(env)];
  }

  save(raw: unknown): SettingsIssue[] {
    const parsed = this.parseChanges(raw);
    if ("issues" in parsed) return parsed.issues;
    const issues = this.check(parsed.changes);
    if (issues.length > 0) return issues;
    try {
      const text = readEnvFile(this.options.envFile);
      writeEnvFile(this.options.envFile, updateEnvText(text, parsed.changes));
      return [];
    } catch (err) {
      return [{ message: (err as Error).message }];
    }
  }

  /** 바꾸려는 토큰(없으면 지금 값)으로 연결을 확인한다. */
  async checkSlack(raw: unknown): Promise<SlackCheckItem[]> {
    const parsed = this.parseChanges(raw);
    const changes = "issues" in parsed ? {} : parsed.changes;
    const env = { ...this.candidate(changes), ...this.options.env };
    return checkSlackTokens({
      botToken: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
    });
  }

  private candidate(changes: SettingsChanges): Record<string, string> {
    const values = readEnvValues(readEnvFile(this.options.envFile));
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
    return values;
  }

  /** 화면이 보낸 변경을 검사한다. 모르는 항목은 받지 않고, 빈 값은 기본값으로 되돌림(null)으로 본다. */
  private parseChanges(
    raw: unknown
  ): { changes: SettingsChanges } | { issues: SettingsIssue[] } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { issues: [{ message: "변경 내용 형식이 올바르지 않습니다." }] };
    }
    const changes: SettingsChanges = {};
    const issues: SettingsIssue[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const field = FIELDS.get(key);
      if (!field) {
        issues.push({ key, message: "설정 화면에서 바꿀 수 없는 항목입니다." });
        continue;
      }
      if (value !== null && typeof value !== "string") {
        issues.push({ key, message: "값 형식이 올바르지 않습니다." });
        continue;
      }
      const trimmed = value?.trim() ?? "";
      if (trimmed === "" && field.required) {
        issues.push({ key, message: "비워 둘 수 없습니다." });
        continue;
      }
      if (trimmed.includes("\n")) {
        issues.push({ key, message: "줄바꿈을 넣을 수 없습니다." });
        continue;
      }
      changes[key] = trimmed === "" ? null : trimmed;
    }
    return issues.length > 0 ? { issues } : { changes };
  }
}
