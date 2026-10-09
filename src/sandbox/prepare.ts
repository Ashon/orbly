import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filterByCidr, parseAnsibleHosts } from "../broker/hosts.js";
import { runProcess } from "../reasoner/process.js";
import { brokerRuntimeDir } from "../settings/paths.js";
import { unsetMount, type BrokerEnv } from "./env.js";

/**
 * Prepares the files to mount outside the repository (brokerRuntimeDir, default ~/.verda/ops-broker) before starting ops-broker.
 * - Puts empty files/directories in place of an unset SSH key, known_hosts, and work directory. The broker treats empty ones as disabled features.
 * - Puts an empty file if kubeconfig is missing. (The kubeconfig job builds it)
 * - If OPS_SSH_INVENTORY is set, rebuilds hosts.json from the ansible inventory.
 */
export async function prepareBrokerFiles(
  env: BrokerEnv,
  processEnv: NodeJS.ProcessEnv,
  log: (line: string) => void
): Promise<void> {
  const runtimeDir = brokerRuntimeDir(processEnv);
  mkdirSync(unsetMount(runtimeDir, "workspace"), { recursive: true });
  for (const name of ["ssh-key", "known_hosts"]) {
    const target = unsetMount(runtimeDir, name);
    if (!existsSync(target)) writeFileSync(target, "");
  }
  const kubeconfig = path.join(runtimeDir, "kubeconfig");
  if (!existsSync(kubeconfig)) writeFileSync(kubeconfig, "", { mode: 0o600 });

  const output = path.join(runtimeDir, "hosts.json");
  if (!env.OPS_SSH_INVENTORY_DIR || !env.OPS_SSH_INVENTORY) {
    if (!existsSync(output)) writeFileSync(output, "{}\n");
    log(
      `${output}: OPS_SSH_INVENTORY_DIR and OPS_SSH_INVENTORY are not set, leaving it as is. (You can edit it by hand)`
    );
    return;
  }
  if (!env.OPS_SSH_ALLOWED_CIDR)
    throw new Error("Set OPS_SSH_ALLOWED_CIDR to use an inventory.");

  const hosts = await renderInventory(env, env.OPS_SSH_ALLOWED_CIDR, processEnv);
  writeFileSync(
    output,
    `${JSON.stringify(Object.fromEntries(hosts.allowed), null, 2)}\n`
  );
  log(
    `${output}: ${hosts.allowed.size} host${hosts.allowed.size === 1 ? "" : "s"} (of ${hosts.total} in the inventory, within ${env.OPS_SSH_ALLOWED_CIDR})`
  );
}

/**
 * Renders the inventory with ansible to get each host's address.
 * ansible_host can be a Jinja expression, so the file is not read directly. Only the debug module runs, so no host is contacted.
 */
async function renderInventory(
  env: BrokerEnv,
  cidr: string,
  processEnv: NodeJS.ProcessEnv
): Promise<{ allowed: Map<string, string>; total: number }> {
  const dir = path.resolve(env.OPS_SSH_INVENTORY_DIR!);
  const venvAnsible = path.join(dir, ".venv/bin/ansible");
  const ansible = existsSync(venvAnsible) ? venvAnsible : "ansible";
  const { stdout } = await runProcess(
    ansible,
    ["-i", env.OPS_SSH_INVENTORY!, "all", "-m", "debug", "-a", "var=ansible_host", "-o"],
    {
      cwd: dir,
      input: "",
      timeoutMs: 120_000,
      env: { ...processEnv, ANSIBLE_NOCOLOR: "1", ANSIBLE_LOAD_CALLBACK_PLUGINS: "0" },
    }
  );
  const all = parseAnsibleHosts(stdout);
  const allowed = new Map(
    [...filterByCidr(all, cidr)].sort(([a], [b]) =>
      a.localeCompare(b, "en", { numeric: true })
    )
  );
  return { allowed, total: all.size };
}
