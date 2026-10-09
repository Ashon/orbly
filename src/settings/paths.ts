import { homedir } from "node:os";
import path from "node:path";
import { defaultHome, envValue } from "./legacy.js";

/**
 * Orbly settings location outside the repository. Holds the config file (.env) and ops-broker runtime files (host list, kubeconfig).
 * It is kept out of the repository so values from target environments do not end up in it.
 * Change the location with the ORBLY_HOME environment variable (VERDA_HOME from before the rename is still read).
 * The default is ~/.orbly, or ~/.verda while ~/.orbly does not exist. (sandbox/compose.yaml defaults to ~/.orbly;
 * the prep commands always pass the resolved location)
 */
export function orblyHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const value = envValue(env, "HOME");
  if (!value) return defaultHome(home);
  return value === "~" || value.startsWith("~/")
    ? path.join(home, value.slice(1))
    : path.resolve(value);
}

/** Config file shared by the bot, desktop app, prep commands, and compose */
export function envFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return path.join(orblyHome(env, home), ".env");
}

/** Egress allowlist. Mounted by the egress proxy. Created from sandbox/proxy/allowed-domains.txt if missing. */
export function allowlistPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return path.join(orblyHome(env, home), "sandbox", "allowed-domains.txt");
}

/** Generated files the broker mounts (hosts.json, kubeconfig) and empty placeholders for unset mounts (unset/) */
export function brokerRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return path.join(orblyHome(env, home), "ops-broker");
}
