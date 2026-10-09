import { createHash, randomBytes } from 'node:crypto'
import type { SlackCheckItem } from '../messengers/slack/check.js'
import {
  HUB_PATHS,
  type HubMe,
  type PairConfirmResponse,
  type PairStartResponse,
  type PairStatus,
} from './protocol.js'

/**
 * A new desktop token for pairing. The token stays on this computer; the hub
 * gets its hash.
 */
export function newHubToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') }
}

/**
 * The desktop's calls to the team hub's pairing and status endpoints
 * (src/hub/server.ts)
 */
export class HubClient {
  private readonly base: string

  constructor(
    url: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = url.replace(/\/+$/, '')
  }

  pairStart(tokenHash: string, label: string): Promise<PairStartResponse> {
    return this.request(HUB_PATHS.pairStart, {
      method: 'POST',
      body: { tokenHash, label },
    })
  }

  pairStatus(pairingId: string): Promise<PairStatus> {
    return this.request(
      `${HUB_PATHS.pairStatus}?pairingId=${encodeURIComponent(pairingId)}`
    )
  }

  pairConfirm(pairingId: string, token: string): Promise<PairConfirmResponse> {
    return this.request(HUB_PATHS.pairConfirm, {
      method: 'POST',
      body: { pairingId, token },
    })
  }

  me(token: string): Promise<HubMe> {
    return this.request(HUB_PATHS.me, { token })
  }

  disconnect(token: string): Promise<{ ok: boolean }> {
    return this.request(HUB_PATHS.disconnect, { method: 'POST', token })
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; token?: string } = {}
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    return body
  }
}

/**
 * "Check connection" for the team hub: reachable, this desktop's pairing, and
 * whether the bot is connected.
 */
export async function checkHub(
  url: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<SlackCheckItem[]> {
  if (!url) return [{ label: 'Hub', ok: false, detail: 'Enter the hub URL.' }]
  const client = new HubClient(url, fetchImpl)
  try {
    const res = await fetchImpl(
      `${url.replace(/\/+$/, '')}${HUB_PATHS.health}`,
      {
        signal: AbortSignal.timeout(10_000),
      }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    return [
      {
        label: 'Hub',
        ok: false,
        detail: `Not reachable: ${(err as Error).message}`,
      },
    ]
  }
  const items: SlackCheckItem[] = [
    { label: 'Hub', ok: true, detail: 'Reachable' },
  ]
  if (!token) {
    items.push({
      label: 'Pairing',
      ok: false,
      detail: 'Not paired yet. Connect below.',
    })
    return items
  }
  try {
    const me = await client.me(token)
    items.push(
      {
        label: 'Pairing',
        ok: true,
        detail: `${me.user.name} (${me.user.id}) @ ${me.team.name}`,
      },
      {
        label: 'Bot',
        ok: me.connected,
        detail: me.connected
          ? 'Connected to the hub'
          : 'Not connected to the hub (start the bot)',
      }
    )
  } catch (err) {
    items.push({ label: 'Pairing', ok: false, detail: (err as Error).message })
  }
  return items
}
