import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Compatibility with installs from before the renames (Verda -> Orbly -> Pacenote). The code reads only PACENOTE_*
 * variables and ~/.pacenote; these helpers map the earlier names onto the current ones so an existing setup keeps
 * working, and say how to migrate. (docs/migrating.md)
 * - Env vars: PACENOTE_* first, then ORBLY_*, then VERDA_*, with a one-time deprecation warning per variable
 * - Home: ~/.pacenote, or else the newest earlier home that exists (~/.orbly, then ~/.verda). User data is never
 *   moved or copied.
 */
export const PRODUCT_NAME = "Pacenote";
export const ENV_PREFIX = "PACENOTE_";
export const HOME_DIR_NAME = ".pacenote";

/** The earlier names, newest first */
export const LEGACY_NAMES = [
  { name: "Orbly", envPrefix: "ORBLY_", homeDir: ".orbly" },
  { name: "Verda", envPrefix: "VERDA_", homeDir: ".verda" },
] as const;

/** The variable's names to look for, current first: PACENOTE_<name>, ORBLY_<name>, VERDA_<name> */
export function envNames(name: string): string[] {
  return [ENV_PREFIX, ...LEGACY_NAMES.map((legacy) => legacy.envPrefix)].map(
    (prefix) => prefix + name
  );
}

/**
 * Copies each set ORBLY_* or VERDA_* variable to its PACENOTE_* name unless that is already set (by the variable
 * itself or a newer earlier name), so the rest of the code reads only PACENOTE_*. Returns a deprecation message per
 * old variable in use.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const messages: string[] = [];
  for (const { envPrefix } of LEGACY_NAMES) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(envPrefix) || !value?.trim()) continue;
      const next = ENV_PREFIX + key.slice(envPrefix.length);
      if (env[next]?.trim()) {
        messages.push(
          `${key} is deprecated and ${next} takes its place. Rename or remove ${key}.`
        );
      } else {
        env[next] = value;
        messages.push(`${key} is deprecated and read as ${next}. Rename it to ${next}.`);
      }
    }
  }
  return messages;
}

/** The value of PACENOTE_<name>, else ORBLY_<name>, else VERDA_<name>, for code that reads an environment it did not prepare. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of envNames(name)) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The default homes, current first: ~/.pacenote, ~/.orbly, ~/.verda */
function homes(home: string): string[] {
  return [HOME_DIR_NAME, ...LEGACY_NAMES.map((legacy) => legacy.homeDir)].map((dir) =>
    path.join(home, dir)
  );
}

/** The default home: ~/.pacenote, or the newest earlier home (~/.orbly, then ~/.verda) while ~/.pacenote does not exist. */
export function defaultHome(
  home = homedir(),
  exists: (file: string) => boolean = existsSync
): string {
  const [current, ...earlier] = homes(home);
  if (exists(current!)) return current!;
  return earlier.find((dir) => exists(dir)) ?? current!;
}

/** The warning for a default home that fell back to an earlier one. Nothing when ~/.pacenote is used or a location is set. */
export function legacyHomeWarning(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  exists: (file: string) => boolean = existsSync
): string | undefined {
  if (envValue(env, "HOME")) return undefined;
  const dir = defaultHome(home, exists);
  const legacy = LEGACY_NAMES.find((entry) => dir === path.join(home, entry.homeDir));
  if (!legacy) return undefined;
  return (
    `Using ${dir} from before the rename to ${PRODUCT_NAME}. To move it: stop the bot, ` +
    `mv ~/${legacy.homeDir} ~/${HOME_DIR_NAME}, rename the ${legacy.envPrefix}* keys in .env to ${ENV_PREFIX}*, and start again.`
  );
}

/**
 * Data folders that may hold a running bot's status file (bot.json): this one and every default home.
 * Checking all of them keeps an old Verda or Orbly and a new Pacenote from connecting to Slack at the same time.
 */
export function botLockDirs(dataDir: string, home = homedir()): string[] {
  return [...new Set([dataDir, ...homes(home)].map((dir) => path.resolve(dir)))];
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
