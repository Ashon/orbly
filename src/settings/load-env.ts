import { readEnvFile, readEnvValues } from "./env-file.js";
import { applyLegacyEnv, legacyHomeWarning } from "./legacy.js";
import { envFilePath } from "./paths.js";

/**
 * Prepares the environment of a process started from the terminal (the bot, the prep commands): reads the
 * settings file under the existing environment, as node --env-file does, then maps the variable names from
 * before the renames (ORBLY_*, VERDA_* -> PACENOTE_*). Returns the warnings, to log once a logger exists.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  for (const [key, value] of Object.entries(
    readEnvValues(readEnvFile(envFilePath(env)))
  )) {
    if (env[key] === undefined) env[key] = value;
  }
  const warnings = applyLegacyEnv(env);
  const home = legacyHomeWarning(env);
  return home ? [home, ...warnings] : warnings;
}
