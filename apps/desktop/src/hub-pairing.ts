import { hostname } from 'node:os'
import { HubClient, newHubToken } from '../../../src/hub/client.js'
import type {
  PairConfirmResponse,
  PairStartResponse,
  PairStatus,
} from '../../../src/hub/protocol.js'
import type { SettingsIssue } from '../../../src/settings/fields.js'
import type { SettingsStore } from './settings.js'

/**
 * Pairs this desktop with the team hub (docs/team-hub.md). The token is made
 * here and stays in the main process until it is saved to .env (HUB_TOKEN); the
 * UI only sees the code and who sent it.
 */
export class HubPairing {
  private pending?: {
    client: HubClient
    url: string
    pairingId: string
    token: string
  }

  constructor(
    private readonly settings: SettingsStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async start(url: unknown): Promise<PairStartResponse> {
    if (
      typeof url !== 'string' ||
      !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(
        url.trim()
      )
    )
      throw new Error('Enter the hub URL (https://...).')
    const hubUrl = url.trim().replace(/\/+$/, '')
    const client = new HubClient(hubUrl, this.fetchImpl)
    const { token, tokenHash } = newHubToken()
    const started = await client.pairStart(
      tokenHash,
      hostname().replace(/\.local$/, '')
    )
    this.pending = { client, url: hubUrl, pairingId: started.pairingId, token }
    return started
  }

  status(): Promise<PairStatus> {
    if (!this.pending) return Promise.resolve({ status: 'expired' })
    return this.pending.client.pairStatus(this.pending.pairingId)
  }

  /**
   * Confirms the member who sent the code, then saves the hub connection to
   * .env.
   */
  async confirm(): Promise<PairConfirmResponse & { issues: SettingsIssue[] }> {
    const pending = this.pending
    if (!pending) throw new Error('No pairing in progress. Connect again.')
    const confirmed = await pending.client.pairConfirm(
      pending.pairingId,
      pending.token
    )
    this.pending = undefined
    const issues = this.settings.save({
      SLACK_CONNECTION: 'hub',
      HUB_URL: pending.url,
      HUB_TOKEN: pending.token,
    })
    return { ...confirmed, issues }
  }

  cancel(): void {
    this.pending = undefined
  }

  /** Unpairs at the hub (best effort) and forgets the token. */
  async disconnect(env: NodeJS.ProcessEnv): Promise<SettingsIssue[]> {
    const url = env.HUB_URL?.trim()
    const token = env.HUB_TOKEN?.trim()
    if (url && token)
      await new HubClient(url, this.fetchImpl)
        .disconnect(token)
        .catch(() => undefined)
    return this.settings.save({ HUB_TOKEN: null })
  }
}
