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
import { checkHub } from "../../../src/hub/client.js";
import {
  checkSlackTokens,
  type SlackCheckItem,
} from "../../../src/messengers/slack/check.js";

const FIELDS = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

/**
 * Reads and writes .env for the Settings screen. The settings file outside the repository (src/settings/paths.ts, default ~/.orbly/.env)
 * is the single source of settings for the bot (both app and terminal).
 * - Secrets are never sent to the UI. (only whether they are set and the last 4 characters)
 * - Validates with the same rules as the bot and broker (checkConfig, checkBrokerEnv) before saving. App environment variables also take precedence over .env the same way.
 * - Entries, comments, and order the Settings screen does not handle are left as is.
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

  /**
   * Validates the bot settings and broker settings together. Settings that are only missing (a Slack token not entered
   * yet) do not block saving: a setup can be saved a piece at a time, and the bot shows "Setup needed" until it is done.
   */
  private check(changes: SettingsChanges): SettingsIssue[] {
    const env = { ...this.candidate(changes), ...this.options.env };
    return [
      ...checkConfig(env).filter((issue) => !issue.missing),
      ...checkBrokerEnv(env),
    ];
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

  /** Checks the connection with the new values (or the current ones if unchanged): the team hub, or the own app's tokens. */
  async checkSlack(raw: unknown): Promise<SlackCheckItem[]> {
    const parsed = this.parseChanges(raw);
    const changes = "issues" in parsed ? {} : parsed.changes;
    const env = { ...this.candidate(changes), ...this.options.env };
    if (env.SLACK_CONNECTION === "hub") return checkHub(env.HUB_URL, env.HUB_TOKEN);
    return checkSlackTokens({
      botToken: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
    });
  }

  /** The settings in effect: the settings file under the app's environment */
  effectiveEnv(): NodeJS.ProcessEnv {
    return { ...this.candidate({}), ...this.options.env };
  }

  private candidate(changes: SettingsChanges): Record<string, string> {
    const values = readEnvValues(readEnvFile(this.options.envFile));
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
    return values;
  }

  /** Checks the changes sent by the UI. Unknown entries are rejected, and empty values mean revert to default (null). */
  private parseChanges(
    raw: unknown
  ): { changes: SettingsChanges } | { issues: SettingsIssue[] } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { issues: [{ message: "The changes format is invalid." }] };
    }
    const changes: SettingsChanges = {};
    const issues: SettingsIssue[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const field = FIELDS.get(key);
      if (!field) {
        issues.push({
          key,
          message: "This entry cannot be changed from the Settings screen.",
        });
        continue;
      }
      if (value !== null && typeof value !== "string") {
        issues.push({ key, message: "The value format is invalid." });
        continue;
      }
      const trimmed = value?.trim() ?? "";
      if (trimmed === "" && field.required) {
        issues.push({ key, message: "Cannot be empty." });
        continue;
      }
      if (trimmed.includes("\n")) {
        issues.push({ key, message: "Cannot contain line breaks." });
        continue;
      }
      changes[key] = trimmed === "" ? null : trimmed;
    }
    return issues.length > 0 ? { issues } : { changes };
  }
}
