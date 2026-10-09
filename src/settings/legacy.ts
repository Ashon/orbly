import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Compatibility with installs from before the rename (Verda -> Orbly). The code reads only ORBLY_*
 * variables and ~/.orbly; these helpers map the old names onto the new ones so an existing setup keeps
 * working, and say how to migrate. (README: "Migrating from Verda")
 * - Env vars: ORBLY_* first, then VERDA_*, with a one-time deprecation warning per variable
 * - Home: ~/.orbly, or ~/.verda while ~/.orbly does not exist. User data is never moved or copied.
 */
export const ENV_PREFIX = "ORBLY_";
export const LEGACY_ENV_PREFIX = "VERDA_";
export const HOME_DIR_NAME = ".orbly";
export const LEGACY_HOME_DIR_NAME = ".verda";

/**
 * Copies each set VERDA_* variable to its ORBLY_* name unless that is already set, so the rest of the
 * code reads only ORBLY_*. Returns a deprecation message per old variable in use.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const messages: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || !value?.trim()) continue;
    const next = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[next]?.trim()) {
      messages.push(
        `${key} is deprecated and ${next} takes its place. Rename or remove ${key}.`
      );
    } else {
      env[next] = value;
      messages.push(`${key} is deprecated and read as ${next}. Rename it to ${next}.`);
    }
  }
  return messages;
}

/** The value of ORBLY_<name>, else VERDA_<name>, for code that reads an environment it did not prepare. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return (
    env[ENV_PREFIX + name]?.trim() || env[LEGACY_ENV_PREFIX + name]?.trim() || undefined
  );
}

/** The default home: ~/.orbly, or ~/.verda from before the rename while ~/.orbly does not exist. */
export function defaultHome(
  home = homedir(),
  exists: (file: string) => boolean = existsSync
): string {
  const dir = path.join(home, HOME_DIR_NAME);
  const legacy = path.join(home, LEGACY_HOME_DIR_NAME);
  return !exists(dir) && exists(legacy) ? legacy : dir;
}

/** The warning for a default home that fell back to ~/.verda. Nothing when ~/.orbly is used or a location is set. */
export function legacyHomeWarning(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  exists: (file: string) => boolean = existsSync
): string | undefined {
  if (envValue(env, "HOME")) return undefined;
  const dir = defaultHome(home, exists);
  if (dir !== path.join(home, LEGACY_HOME_DIR_NAME)) return undefined;
  return (
    `Using ${dir} from before the rename to Orbly. To move it: stop the bot, ` +
    `mv ~/${LEGACY_HOME_DIR_NAME} ~/${HOME_DIR_NAME}, rename the VERDA_* keys in .env to ORBLY_*, and start again.`
  );
}

/**
 * Data folders that may hold a running bot's status file (bot.json): this one and both default homes.
 * Checking all of them keeps an old Verda and a new Orbly from connecting to Slack at the same time.
 */
export function botLockDirs(dataDir: string, home = homedir()): string[] {
  const dirs = [
    dataDir,
    path.join(home, HOME_DIR_NAME),
    path.join(home, LEGACY_HOME_DIR_NAME),
  ];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

const warned = new Set<string>();

/** Writes each message once per process, however many times the same setup is read. */
export function warnOnce(
  messages: readonly string[],
  warn: (message: string) => void
): void {
  for (const message of messages) {
    if (warned.has(message)) continue;
    warned.add(message);
    warn(message);
  }
}
