/**
 * Pacenote team hub. One server holds the Slack app's Socket Mode connection
 * and its tokens; each team member's Pacenote desktop connects to it and
 * answers that member's mentions with their own reasoner CLI.
 * - Desktops never hold a Slack token. Their Slack Web API calls, file
 *   downloads and uploads go through the hub, which allows only what the thread
 *   routed to them needs. (src/hub/policy.ts)
 * - A desktop pairs once: it shows a code, the member sends "@Pacey connect
 *   <code>" in Slack, and the desktop confirms the Slack user who sent it. The
 *   desktop then keeps a token only the hub can check (it stores a hash).
 * Shared by the hub (src/hub) and the desktop
 * (src/messengers/slack/hub-receiver.ts, src/hub/client.ts), so it has no Node
 * APIs.
 */

export interface HubUser {
  id: string
  name: string
}

export interface HubTeam {
  id: string
  name: string
}

/** WebSocket close codes the hub uses */
export const HUB_CLOSE = {
  /** The same member connected another desktop, or paired again */
  replaced: 4001,
  /** The desktop was disconnected (unpaired) */
  revoked: 4002,
} as const

/** Hub -> desktop messages on the /connect WebSocket */
export type HubMessage =
  | { type: 'ready'; user: HubUser; team: HubTeam }
  /**
   * An Events API payload (event_callback) for an app_mention by this desktop's
   * member
   */
  | { type: 'event'; body: Record<string, unknown> }
  | { type: 'revoked'; reason: string }

/** Keepalive: the desktop sends PING as text and the hub answers PONG. */
export const PING = 'ping'
export const PONG = 'pong'

export const HUB_PATHS = {
  health: '/health',
  connect: '/connect',
  /** Slack Web API proxy: POST /api/<method>, as the Slack client sends it */
  api: '/api/',
  /** GET /files?url=<url_private_download> */
  files: '/files',
  /**
   * POST /upload?key=<key>: the upload URLs files.getUploadURLExternal returns,
   * rewritten to the hub
   */
  upload: '/upload',
  pairStart: '/pair/start',
  pairStatus: '/pair/status',
  pairConfirm: '/pair/confirm',
  me: '/me',
  disconnect: '/disconnect',
} as const

/**
 * POST /pair/start body: the desktop keeps the token and sends only its hash
 */
export interface PairStartRequest {
  tokenHash: string
  /** Shown to the member in Slack and in the hub log, e.g. the computer name */
  label: string
}

export interface PairStartResponse {
  pairingId: string
  /** What the member sends in Slack: "@Pacey connect <code>" */
  code: string
  expiresAt: string
}

export type PairStatus =
  | { status: 'pending' }
  /** A Slack member sent the code; the desktop shows who and confirms */
  | { status: 'bound'; user: HubUser }
  | { status: 'expired' }

/**
 * POST /pair/confirm body. The token proves this is the desktop that started
 * the pairing.
 */
export interface PairConfirmRequest {
  pairingId: string
  token: string
}

export interface PairConfirmResponse {
  user: HubUser
  team: HubTeam
}

/** GET /me: who the desktop's token belongs to */
export interface HubMe {
  user: HubUser
  team: HubTeam
  /** Whether this desktop has a live /connect WebSocket */
  connected: boolean
}

/** Desktop tokens, token hashes and pairing ids: random bytes as hex */
export const HEX64 = /^[0-9a-f]{64}$/
export const PAIRING_ID = /^[0-9a-f]{32}$/

/**
 * The mention text that pairs a desktop: "connect ABCD-2345" after the bot
 * mention
 */
export const CONNECT_COMMAND =
  /\bconnect\s+([A-Za-z0-9]{4})-?([A-Za-z0-9]{4})\b/
