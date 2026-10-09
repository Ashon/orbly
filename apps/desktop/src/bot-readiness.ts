import { checkConfig, type ConfigIssue } from "../../../src/config.js";

/**
 * Why the bot cannot run yet. The supervisor shows it as "Setup needed" and does not launch the bot,
 * instead of letting it exit on a config error and calling that a crash.
 * - slack: the Slack tokens are missing (a first run) or Slack rejected them
 * - config: other values fail the bot's own validation
 */
export interface SetupProblem {
  kind: "slack" | "config";
  message: string;
  /** Validation issues to list, for kind "config" */
  issues: ConfigIssue[];
}

const SLACK_TOKENS = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"];

/** Checks the environment the bot would get with the bot's own rules (checkConfig), before launching it. */
export function setupProblem(
  env: NodeJS.ProcessEnv,
  check: (env: NodeJS.ProcessEnv) => ConfigIssue[] = checkConfig
): SetupProblem | undefined {
  const issues = check(env);
  if (issues.length === 0) return undefined;
  if (SLACK_TOKENS.some((key) => !env[key]?.trim())) {
    return {
      kind: "slack",
      message:
        "Slack is not connected yet. Enter the app token and the bot token in Settings to start the bot.",
      issues: [],
    };
  }
  return {
    kind: "config",
    message: "Some settings need fixing before the bot can start.",
    issues,
  };
}

/** Slack API errors that mean the token itself is wrong, revoked, or belongs to a disabled account */
const SLACK_AUTH_ERROR =
  /\b(invalid_auth|not_authed|account_inactive|token_revoked|token_expired|invalid_token)\b/;

/**
 * A bot that exits right after starting because Slack rejected its tokens also needs setup, not a
 * restart. Reads the bot's last output for the Slack error code.
 */
export function startFailureProblem(output: readonly string[]): SetupProblem | undefined {
  for (const line of [...output].reverse()) {
    const code = SLACK_AUTH_ERROR.exec(line)?.[1];
    if (code) {
      return {
        kind: "slack",
        message: `Slack rejected the tokens (${code}). Check them with "Check connection" in Settings, then save to start the bot.`,
        issues: [],
      };
    }
  }
  return undefined;
}
