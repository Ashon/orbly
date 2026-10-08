import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filterByCidr, parseAnsibleHosts } from "../broker/hosts.js";
import { runProcess } from "../reasoner/process.js";
import { brokerRuntimeDir } from "../settings/paths.js";
import { unsetMount, type BrokerEnv } from "./env.js";

/**
 * ops-broker 를 띄우기 전에 마운트할 파일을 저장소 밖(brokerRuntimeDir, 기본 ~/.verda/ops-broker)에 준비한다.
 * - 설정하지 않은 SSH 키, known_hosts, 작업 디렉터리 자리에 빈 파일/디렉터리를 둔다. broker 는 빈 것을 꺼진 기능으로 본다.
 * - kubeconfig 가 없으면 빈 파일을 둔다. (kubeconfig 작업으로 만든다)
 * - OPS_SSH_INVENTORY 를 설정했으면 ansible 인벤토리로 hosts.json 을 다시 만든다.
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
      `${output}: OPS_SSH_INVENTORY_DIR, OPS_SSH_INVENTORY 가 없어 그대로 둡니다. (직접 써도 된다)`
    );
    return;
  }
  if (!env.OPS_SSH_ALLOWED_CIDR)
    throw new Error("인벤토리를 쓰려면 OPS_SSH_ALLOWED_CIDR 를 설정해야 합니다.");

  const hosts = await renderInventory(env, env.OPS_SSH_ALLOWED_CIDR, processEnv);
  writeFileSync(
    output,
    `${JSON.stringify(Object.fromEntries(hosts.allowed), null, 2)}\n`
  );
  log(
    `${output}: ${hosts.allowed.size}개 (인벤토리 ${hosts.total}개 중 ${env.OPS_SSH_ALLOWED_CIDR} 안)`
  );
}

/**
 * 인벤토리를 ansible 로 렌더링해서 호스트별 주소를 얻는다.
 * ansible_host 가 Jinja 계산식일 수 있어서 파일을 직접 읽지 않는다. debug 모듈만 쓰므로 호스트에 접속하지 않는다.
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
