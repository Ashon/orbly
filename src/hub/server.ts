import { createHash, randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Logger } from '../logger.js'
import type { Pairings } from './pairing.js'
import { Grants, type MentionEvent } from './policy.js'
import {
  CONNECT_COMMAND,
  HEX64,
  HUB_CLOSE,
  HUB_PATHS,
  type HubMe,
  type HubMessage,
  type HubTeam,
  type PairConfirmResponse,
  PAIRING_ID,
  PING,
  PONG,
} from './protocol.js'
import type { DesktopRecord, DesktopStore } from './store.js'

/**
 * The hub's side of Slack: calls made with the bot token, which never leaves
 * the hub
 */
export interface SlackGateway {
  /** Calls a Web API method, forwarding the body as the desktop sent it */
  call(
    method: string,
    body: string,
    contentType: string
  ): Promise<{
    status: number
    json: Record<string, unknown>
    retryAfter?: string
  }>
  download(url: string): Promise<Response>
  upload(
    url: string,
    body: Buffer,
    contentType: string | undefined
  ): Promise<Response>
  postEphemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string
  ): Promise<void>
  userName(userId: string): Promise<string>
}

export interface HubOptions {
  store: DesktopStore
  pairings: Pairings
  slack: SlackGateway
  team: HubTeam
  /** Members who may pair and use the hub. Empty: everyone in the workspace */
  allowedUsers?: readonly string[]
  /**
   * The URL desktops reach the hub at, for rewritten upload URLs. Else taken
   * from the request (X-Forwarded-*).
   */
  publicUrl?: string
  /**
   * Where Slack serves files (slackFilesOrigin of SLACK_API_URL). Default
   * https://files.slack.com
   */
  filesOrigin?: string
  log: Logger
}

const MAX_API_BODY = 2 * 1024 * 1024
const MAX_UPLOAD_BODY = 50 * 1024 * 1024
const UPLOAD_TTL_MS = 10 * 60_000
const HEARTBEAT_MS = 30_000

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const NOTICES = {
  notPaired:
    "This Slack workspace answers through each member's own Pacenote desktop app, and yours is not connected yet. " +
    'In Pacenote, open Settings > Messengers > Slack, choose the team hub and connect, then send me the code it shows.',
  offline:
    'Your Pacenote desktop is not connected to the hub right now. Open Pacenote on your computer and mention me again.',
  notAllowed:
    "You are not on the list of members who can use Pacenote here. Ask the hub's admin.",
  paired: (label: string) =>
    `Code accepted for "${label}". Confirm the pairing in your Pacenote app to finish.`,
  unknownCode:
    'That code is not valid or has expired. Start again in Pacenote (Settings > Messengers > Slack) for a new one.',
  takenCode:
    'Someone else already sent that code. Start again in Pacenote for a new one.',
}

/**
 * The hub server: pairing (HTTP), desktop connections (WebSocket /connect),
 * mention routing, and the Slack proxy desktops make their calls through. Runs
 * behind HTTPS in production (docs/team-hub.md).
 */
export class HubServer {
  readonly http: Server
  private readonly wss = new WebSocketServer({ noServer: true })
  /** Desktop id -> its live connection */
  private readonly sockets = new Map<string, WebSocket>()
  private readonly grants = new Map<string, Grants>()
  /** Upload key -> the Slack upload URL it stands for */
  private readonly uploads = new Map<
    string,
    { desktopId: string; url: string; expiresAt: number }
  >()
  private readonly alive = new WeakMap<WebSocket, boolean>()
  private readonly heartbeat: NodeJS.Timeout

  constructor(private readonly options: HubOptions) {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        options.log.error(`Request failed: ${req.method} ${req.url}`, err)
        if (!res.headersSent) json(res, 500, { ok: false, error: 'hub_error' })
        else res.end()
      })
    })
    this.http.on('upgrade', (req, socket, head) =>
      this.upgrade(req, socket, head)
    )
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        const address = this.http.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const ws of this.sockets.values()) ws.close(1001, 'Hub shutting down')
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  /**
   * Routes an app_mention (its event_callback body) to the member's desktop, or
   * handles "connect <code>".
   */
  async handleMention(body: Record<string, unknown>): Promise<void> {
    const event = body.event as (MentionEvent & { text?: string }) | undefined
    const user = event?.user
    if (!event || !user) return
    const { slack, store, log } = this.options
    const notice = (text: string) =>
      slack
        .postEphemeral(event.channel, user, text, event.thread_ts)
        .catch((err: unknown) =>
          log.warn(
            `Could not send a notice to ${user}: ${(err as Error).message}`
          )
        )
    const allowed = this.options.allowedUsers ?? []
    if (allowed.length > 0 && !allowed.includes(user))
      return notice(NOTICES.notAllowed)

    const command = CONNECT_COMMAND.exec(event.text ?? '')
    if (command) {
      const name = await slack.userName(user).catch(() => user)
      const code = `${command[1]}-${command[2]}`
      const bound = this.options.pairings.bind(code, { id: user, name })
      log.info(`Pairing code from ${name} (${user}): ${bound.result}`)
      return notice(
        bound.result === 'bound'
          ? NOTICES.paired(bound.label)
          : bound.result === 'taken'
            ? NOTICES.takenCode
            : NOTICES.unknownCode
      )
    }

    const desktop = store.byUser(user)
    if (!desktop) return notice(NOTICES.notPaired)
    const ws = this.sockets.get(desktop.id)
    if (!ws || ws.readyState !== ws.OPEN) return notice(NOTICES.offline)
    this.grantsOf(desktop.id).add(event)
    send(ws, { type: 'event', body })
    log.info(
      `Routed a mention in ${event.channel} to ${desktop.user.name}'s desktop (${desktop.label})`
    )
  }

  private grantsOf(desktopId: string): Grants {
    let grants = this.grants.get(desktopId)
    if (!grants)
      this.grants.set(
        desktopId,
        (grants = new Grants(Date.now, this.options.filesOrigin))
      )
    return grants
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub')
    const { pairings, store, team } = this.options

    if (req.method === 'GET' && url.pathname === HUB_PATHS.health)
      return json(res, 200, { ok: true })

    if (req.method === 'POST' && url.pathname === HUB_PATHS.pairStart) {
      const body = await readJson(req)
      const tokenHash = String(body?.tokenHash ?? '')
      const label =
        String(body?.label ?? '').slice(0, 100) || 'Pacenote desktop'
      if (!HEX64.test(tokenHash))
        return json(res, 400, { error: 'invalid_request' })
      return json(res, 200, pairings.start(tokenHash, label))
    }
    if (req.method === 'GET' && url.pathname === HUB_PATHS.pairStatus) {
      const pairingId = url.searchParams.get('pairingId') ?? ''
      if (!PAIRING_ID.test(pairingId))
        return json(res, 400, { error: 'invalid_request' })
      return json(res, 200, pairings.status(pairingId))
    }
    if (req.method === 'POST' && url.pathname === HUB_PATHS.pairConfirm) {
      const body = await readJson(req)
      const pairingId = String(body?.pairingId ?? '')
      const token = String(body?.token ?? '')
      if (!PAIRING_ID.test(pairingId) || !HEX64.test(token))
        return json(res, 400, { error: 'invalid_request' })
      const confirmed = pairings.confirm(pairingId, sha256(token))
      if (!confirmed) return json(res, 409, { error: 'not_confirmable' })
      const { desktop, replaced } = store.add(
        sha256(token),
        confirmed.user,
        confirmed.label
      )
      if (replaced)
        this.drop(replaced, HUB_CLOSE.replaced, 'Paired a new desktop')
      this.options.log.info(
        `Paired ${desktop.user.name} (${desktop.user.id}) with "${desktop.label}"${replaced ? `, replacing "${replaced.label}"` : ''}`
      )
      return json(res, 200, {
        user: desktop.user,
        team,
      } satisfies PairConfirmResponse)
    }

    // Everything below needs a paired desktop's token.
    const desktop = this.authenticate(req)
    if (!desktop)
      // Slack API calls get a Slack-shaped error (HTTP 200), so the desktop's
      // Slack client reports hub_unauthorized.
      return json(res, url.pathname.startsWith(HUB_PATHS.api) ? 200 : 401, {
        ok: false,
        error: 'hub_unauthorized',
      })

    if (req.method === 'GET' && url.pathname === HUB_PATHS.me) {
      const ws = this.sockets.get(desktop.id)
      return json(res, 200, {
        user: desktop.user,
        team,
        connected: Boolean(ws && ws.readyState === ws.OPEN),
      } satisfies HubMe)
    }
    if (req.method === 'POST' && url.pathname === HUB_PATHS.disconnect) {
      store.remove(desktop.id)
      this.drop(desktop, HUB_CLOSE.revoked, 'Disconnected from the app')
      this.options.log.info(
        `Unpaired ${desktop.user.name}'s desktop "${desktop.label}"`
      )
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname.startsWith(HUB_PATHS.api))
      return this.proxyApi(
        req,
        res,
        desktop,
        url.pathname.slice(HUB_PATHS.api.length)
      )
    if (req.method === 'GET' && url.pathname === HUB_PATHS.files)
      return this.proxyDownload(res, desktop, url.searchParams.get('url') ?? '')
    if (req.method === 'POST' && url.pathname === HUB_PATHS.upload)
      return this.proxyUpload(
        req,
        res,
        desktop,
        url.searchParams.get('key') ?? ''
      )
    return json(res, 404, { error: 'not_found' })
  }

  private async proxyApi(
    req: IncomingMessage,
    res: ServerResponse,
    desktop: DesktopRecord,
    method: string
  ): Promise<void> {
    if (!/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(method))
      return json(res, 404, { ok: false, error: 'unknown_method' })
    const raw = (await readBody(req, MAX_API_BODY)).toString('utf8')
    const contentType =
      req.headers['content-type'] ?? 'application/x-www-form-urlencoded'
    const args = parseArgs(raw, contentType)
    const grants = this.grantsOf(desktop.id)
    const decision = grants.authorize(method, args)
    if (!decision.ok) {
      this.options.log.warn(
        `Refused ${method} from ${desktop.user.name}'s desktop: ${decision.error}`
      )
      // Same shape as a Slack error, so the desktop's Slack client reports it
      // as one.
      return json(res, 200, { ok: false, error: decision.error })
    }
    const result = await this.options.slack.call(method, raw, contentType)
    grants.observe(method, args, result.json)
    if (
      method === 'files.getUploadURLExternal' &&
      typeof result.json.upload_url === 'string'
    )
      result.json.upload_url = this.rewriteUpload(
        req,
        desktop.id,
        result.json.upload_url
      )
    if (result.retryAfter) res.setHeader('Retry-After', result.retryAfter)
    return json(res, result.status, result.json)
  }

  private async proxyDownload(
    res: ServerResponse,
    desktop: DesktopRecord,
    fileUrl: string
  ): Promise<void> {
    if (!this.grantsOf(desktop.id).canDownload(fileUrl))
      return json(res, 403, { ok: false, error: 'file_not_granted' })
    const upstream = await this.options.slack.download(fileUrl)
    res.statusCode = upstream.status
    for (const header of [
      'content-type',
      'content-length',
      'content-disposition',
    ]) {
      const value = upstream.headers.get(header)
      if (value) res.setHeader(header, value)
    }
    res.end(Buffer.from(await upstream.arrayBuffer()))
  }

  private async proxyUpload(
    req: IncomingMessage,
    res: ServerResponse,
    desktop: DesktopRecord,
    key: string
  ): Promise<void> {
    const upload = this.uploads.get(key)
    if (
      !upload ||
      upload.desktopId !== desktop.id ||
      upload.expiresAt < Date.now()
    )
      return json(res, 403, { ok: false, error: 'upload_not_granted' })
    this.uploads.delete(key)
    const upstream = await this.options.slack.upload(
      upload.url,
      await readBody(req, MAX_UPLOAD_BODY),
      req.headers['content-type']
    )
    res.statusCode = upstream.status
    res.end(await upstream.text())
  }

  private rewriteUpload(
    req: IncomingMessage,
    desktopId: string,
    url: string
  ): string {
    const key = randomBytes(16).toString('hex')
    this.uploads.set(key, {
      desktopId,
      url,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    })
    for (const [k, v] of this.uploads)
      if (v.expiresAt < Date.now()) this.uploads.delete(k)
    return `${this.publicUrl(req)}${HUB_PATHS.upload}?key=${key}`
  }

  private publicUrl(req: IncomingMessage): string {
    if (this.options.publicUrl) return this.options.publicUrl.replace(/\/$/, '')
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
      .split(',')[0]!
      .trim()
    const host = String(
      req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'
    )
    return `${proto}://${host}`
  }

  private authenticate(req: IncomingMessage): DesktopRecord | undefined {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(
      req.headers.authorization ?? ''
    )?.[1]
    return token ? this.options.store.byTokenHash(sha256(token)) : undefined
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://hub')
    const desktop =
      url.pathname === HUB_PATHS.connect ? this.authenticate(req) : undefined
    if (!desktop) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
      )
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(desktop, ws))
  }

  private attach(desktop: DesktopRecord, ws: WebSocket): void {
    const previous = this.sockets.get(desktop.id)
    if (previous)
      previous.close(HUB_CLOSE.replaced, 'Replaced by a newer connection')
    this.sockets.set(desktop.id, ws)
    this.alive.set(ws, true)
    this.options.store.touch(desktop.id)
    this.options.log.info(
      `${desktop.user.name}'s desktop "${desktop.label}" connected`
    )
    ws.on('pong', () => this.alive.set(ws, true))
    ws.on('message', (data) => {
      this.alive.set(ws, true)
      if (data.toString() === PING) ws.send(PONG)
    })
    ws.on('close', () => {
      if (this.sockets.get(desktop.id) !== ws) return
      this.sockets.delete(desktop.id)
      this.options.log.info(
        `${desktop.user.name}'s desktop "${desktop.label}" disconnected`
      )
    })
    send(ws, { type: 'ready', user: desktop.user, team: this.options.team })
  }

  /** Closes a desktop's connection and forgets its grants. */
  private drop(desktop: DesktopRecord, code: number, reason: string): void {
    const ws = this.sockets.get(desktop.id)
    if (ws) {
      if (code === HUB_CLOSE.revoked) send(ws, { type: 'revoked', reason })
      ws.close(code, reason)
      this.sockets.delete(desktop.id)
    }
    this.grants.delete(desktop.id)
  }

  private beat(): void {
    for (const ws of this.sockets.values()) {
      if (this.alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      this.alive.set(ws, false)
      ws.ping()
    }
  }
}

function send(ws: WebSocket, message: HubMessage): void {
  ws.send(JSON.stringify(message))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(
  req: IncomingMessage
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(
      (await readBody(req, 64 * 1024)).toString('utf8')
    ) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Web API arguments as strings, the way the policy reads them (nested values
 * stay JSON strings)
 */
export function parseArgs(
  raw: string,
  contentType: string
): Record<string, string> {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        ])
      )
    } catch {
      return {}
    }
  }
  return Object.fromEntries(new URLSearchParams(raw))
}
