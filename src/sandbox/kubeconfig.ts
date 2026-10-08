import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../reasoner/process.js";
import { brokerRuntimeDir } from "../settings/paths.js";
import { splitList, type BrokerEnv } from "./env.js";

interface KubeConfigView {
  contexts?: { name: string; context: { cluster: string } }[];
  clusters?: {
    name: string;
    cluster: { server: string; "certificate-authority-data"?: string };
  }[];
}

/**
 * ops-broker 용 조회 전용 kubeconfig 를 만든다.
 * 클러스터 주소와 CA 는 로컬 kubeconfig 에서, 토큰은 각 클러스터의 ServiceAccount 토큰 Secret 에서 읽는다.
 * 로컬 kubeconfig 의 관리자 인증 정보는 결과 파일에 들어가지 않는다.
 */
export async function writeKubeconfig(
  env: BrokerEnv,
  processEnv: NodeJS.ProcessEnv,
  log: (line: string) => void
): Promise<void> {
  const contexts = splitList(env.OPS_K8S_CONTEXTS);
  if (contexts.length === 0)
    throw new Error(
      "OPS_K8S_CONTEXTS 에 조회할 kubeconfig 컨텍스트를 쉼표로 지정하세요."
    );
  const serviceAccount = env.OPS_K8S_SA;
  const namespace = env.OPS_K8S_SA_NAMESPACE;
  const output = path.join(brokerRuntimeDir(processEnv), "kubeconfig");

  const kubectl = async (args: string[]) =>
    (
      await runProcess("kubectl", args, {
        cwd: process.cwd(),
        input: "",
        timeoutMs: 30_000,
        env: processEnv,
      })
    ).stdout;
  const view = JSON.parse(
    await kubectl(["config", "view", "--raw", "-o", "json"])
  ) as KubeConfigView;

  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [] as unknown[],
    users: [] as unknown[],
    contexts: [] as unknown[],
    "current-context": contexts[0],
  };
  for (const name of contexts) {
    const context = view.contexts?.find((c) => c.name === name);
    const cluster = view.clusters?.find(
      (c) => c.name === context?.context.cluster
    )?.cluster;
    if (!context || !cluster)
      throw new Error(`로컬 kubeconfig 에 컨텍스트가 없습니다: ${name}`);

    const encoded = await kubectl([
      "--context",
      name,
      "--namespace",
      namespace,
      "get",
      "secret",
      `${serviceAccount}-token`,
      "-o",
      "jsonpath={.data.token}",
    ]);
    if (!encoded.trim())
      throw new Error(
        `${name}: ${namespace}/${serviceAccount}-token 토큰이 비어 있습니다.`
      );
    const token = Buffer.from(encoded.trim(), "base64").toString("utf8");

    const user = `${name}-${serviceAccount}`;
    config.clusters.push({
      name,
      cluster: {
        server: cluster.server,
        "certificate-authority-data": cluster["certificate-authority-data"],
      },
    });
    config.users.push({ name: user, user: { token } });
    config.contexts.push({ name, context: { cluster: name, user } });
  }

  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  log(`${output}: ${contexts.join(", ")} (${namespace}/${serviceAccount})`);
}
