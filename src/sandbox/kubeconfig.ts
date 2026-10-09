import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '../reasoner/process.js'
import { brokerRuntimeDir } from '../settings/paths.js'
import { splitList, type BrokerEnv } from './env.js'

interface KubeConfigView {
  contexts?: { name: string; context: { cluster: string } }[]
  clusters?: {
    name: string
    cluster: { server: string; 'certificate-authority-data'?: string }
  }[]
}

/**
 * Builds the read-only kubeconfig for ops-broker.
 * Cluster URLs and CAs come from the local kubeconfig, and tokens from each
 * cluster's ServiceAccount token Secret. Admin credentials in the local
 * kubeconfig never end up in the output file.
 */
export async function writeKubeconfig(
  env: BrokerEnv,
  processEnv: NodeJS.ProcessEnv,
  log: (line: string) => void
): Promise<void> {
  const contexts = splitList(env.OPS_K8S_CONTEXTS)
  if (contexts.length === 0)
    throw new Error(
      'Set OPS_K8S_CONTEXTS to a comma-separated list of kubeconfig contexts to query.'
    )
  const serviceAccount = env.OPS_K8S_SA
  const namespace = env.OPS_K8S_SA_NAMESPACE
  const output = path.join(brokerRuntimeDir(processEnv), 'kubeconfig')

  const kubectl = async (args: string[]) =>
    (
      await runProcess('kubectl', args, {
        cwd: process.cwd(),
        input: '',
        timeoutMs: 30_000,
        env: processEnv,
      })
    ).stdout
  const view = JSON.parse(
    await kubectl(['config', 'view', '--raw', '-o', 'json'])
  ) as KubeConfigView

  const config = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [] as unknown[],
    users: [] as unknown[],
    contexts: [] as unknown[],
    'current-context': contexts[0],
  }
  for (const name of contexts) {
    const context = view.contexts?.find((c) => c.name === name)
    const cluster = view.clusters?.find(
      (c) => c.name === context?.context.cluster
    )?.cluster
    if (!context || !cluster)
      throw new Error(`Context not found in the local kubeconfig: ${name}`)

    const encoded = await kubectl([
      '--context',
      name,
      '--namespace',
      namespace,
      'get',
      'secret',
      `${serviceAccount}-token`,
      '-o',
      'jsonpath={.data.token}',
    ])
    if (!encoded.trim())
      throw new Error(
        `${name}: the ${namespace}/${serviceAccount}-token token is empty.`
      )
    const token = Buffer.from(encoded.trim(), 'base64').toString('utf8')

    const user = `${name}-${serviceAccount}`
    config.clusters.push({
      name,
      cluster: {
        server: cluster.server,
        'certificate-authority-data': cluster['certificate-authority-data'],
      },
    })
    config.users.push({ name: user, user: { token } })
    config.contexts.push({ name, context: { cluster: name, user } })
  }

  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  log(`${output}: ${contexts.join(', ')} (${namespace}/${serviceAccount})`)
}
