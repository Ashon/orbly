// Draws the design diagrams in docs/diagrams as SVG, in the desktop app's look
// (apps/web/src/index.css): the emerald to mint gradient, surfaces instead of
// borders (canvas, card, well), 20px cards with a faint shadow, the system
// font, and mono for code. Each diagram comes in a light and a dark variant for
// GitHub's <picture>. Usage: node scripts/diagrams.mjs (pnpm docs:diagrams)
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname, '../docs/diagrams')

// The app's tokens (oklch in index.css, as hex so every SVG renderer agrees)
const THEMES = {
  light: {
    canvas: '#f5faf8',
    card: '#ffffff',
    cardAccent: '#e7fff4',
    well: '#eef6f2',
    foreground: '#10211c',
    muted: '#4f665e',
    faint: '#8aa199',
    line: '#b7cbc3',
    primary: '#007c5c',
    accent: '#d9f6e8',
    accentFg: '#003e2a',
    running: '#029a92',
    succeeded: '#007c5c',
    interrupted: '#be7100',
    failed: '#d42f34',
    shadow: { color: '#0f2a20', opacity: 0.08 },
  },
  dark: {
    canvas: '#09100e',
    card: '#121c19',
    cardAccent: '#0f271e',
    well: '#0c1513',
    foreground: '#e1ebe6',
    muted: '#93a79e',
    faint: '#61756d',
    line: '#2c3c36',
    primary: '#3ccb96',
    accent: '#112e24',
    accentFg: '#daf2e6',
    running: '#1bd3b3',
    succeeded: '#3ccb96',
    interrupted: '#e9a84a',
    failed: '#f66c6d',
    shadow: { color: '#000000', opacity: 0.45 },
  },
}

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Pretendard, 'Noto Sans KR', Helvetica, Arial, sans-serif"
const MONO =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A diagram drawn into one theme: shapes go in order, later ones on top */
class Canvas {
  constructor(t, width, height) {
    this.t = t
    this.width = width
    this.height = height
    this.parts = []
  }

  add(svg) {
    this.parts.push(svg)
    return this
  }

  text(x, y, value, o = {}) {
    const {
      size = 12.5,
      weight = 400,
      fill = this.t.foreground,
      mono = false,
      anchor = 'start',
      italic = false,
    } = o
    return this.add(
      `<text x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${weight}"` +
        `${italic ? ' font-style="italic"' : ''} fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`
    )
  }

  /** A raised surface, like the app's surface-card */
  card(x, y, w, h, o = {}) {
    const fill = o.accent ? this.t.cardAccent : this.t.card
    this.add(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.radius ?? 18}" fill="${fill}" filter="url(#shadow)"/>`
    )
    if (o.title) this.text(x + 18, y + 30, o.title, { size: 15, weight: 600 })
    if (o.sub)
      this.text(x + 18, y + 49, o.sub, { size: 12, fill: this.t.muted })
    return this
  }

  /** A recessed surface inside a card, for lists and code */
  well(x, y, w, h, o = {}) {
    return this.add(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.radius ?? 12}" fill="${this.t.well}"/>`
    )
  }

  /** A well with a mono label and a line of help under it */
  item(x, y, w, label, help, o = {}) {
    const h = help ? 46 : 30
    this.well(x, y, w, h, o)
    this.text(x + 12, y + 19, label, {
      mono: o.mono ?? true,
      size: 12,
      weight: 600,
      fill: o.labelFill ?? this.t.foreground,
    })
    if (help)
      this.text(x + 12, y + 36, help, { size: 11.5, fill: this.t.muted })
    return this
  }

  /**
   * Room for an adapter that does not exist yet: a dashed outline with faint
   * text
   */
  slot(x, y, w, label) {
    this.add(
      `<rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="28.5" rx="12" fill="none"` +
        ` stroke="${this.t.line}" stroke-width="1.5" stroke-dasharray="5 4"/>`
    )
    return this.text(x + 12, y + 19, label, { size: 12, fill: this.t.faint })
  }

  /** A small rounded label; tone picks a status color */
  chip(x, y, value, o = {}) {
    const tone = o.tone ? this.t[o.tone] : this.t.accentFg
    const width = o.width ?? Math.round(value.length * 6.6 + 18)
    this.add(
      `<rect x="${x}" y="${y}" width="${width}" height="20" rx="10" fill="${o.tone ? tone : this.t.accent}" fill-opacity="${o.tone ? 0.14 : 1}"/>`
    )
    this.text(x + width / 2, y + 14, value, {
      size: 11,
      weight: 600,
      fill: tone,
      anchor: 'middle',
    })
    return width
  }

  /** A numbered step marker in the gradient */
  step(x, y, n) {
    this.add(`<circle cx="${x}" cy="${y}" r="11" fill="url(#mark)"/>`)
    return this.text(x, y + 4, n, {
      size: 11.5,
      weight: 700,
      fill: '#ffffff',
      anchor: 'middle',
    })
  }

  /**
   * A line between points; main lines are primary, others muted; dashed for
   * optional paths
   */
  arrow(points, o = {}) {
    const color = o.main ? this.t.primary : this.t.faint
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
    this.add(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.main ? 2 : 1.5}" stroke-linecap="round"` +
        ` stroke-linejoin="round"${o.dashed ? ' stroke-dasharray="5 5"' : ''}` +
        `${o.end === false ? '' : ` marker-end="url(#${o.main ? 'arrow-main' : 'arrow'})"`}` +
        `${o.start ? ` marker-start="url(#${o.main ? 'arrow-main' : 'arrow'})"` : ''}/>`
    )
    if (o.label) {
      const [x, y] = o.at ?? points[0]
      const width = Math.round(o.label.length * 6.3 + 14)
      const lx = o.anchor === 'middle' ? x - width / 2 : x
      this.add(
        `<rect x="${lx}" y="${y - 13}" width="${width}" height="19" rx="9.5" fill="${this.t.canvas}"/>`
      )
      this.text(lx + width / 2, y + 1, o.label, {
        size: 11,
        fill: o.main ? this.t.primary : this.t.muted,
        anchor: 'middle',
        weight: o.main ? 600 : 400,
      })
    }
    return this
  }

  /** The Pacenote mark (assets/pacenote.svg), size px wide */
  mark(x, y, size) {
    const s = size / 412
    return this.add(
      `<g transform="translate(${x - 50 * s} ${y - 50 * s}) scale(${s})">` +
        `<path d="M273.1 92.9A164 164 0 1 0 419.1 238.9" fill="none" stroke="url(#mark-big)" stroke-width="84" stroke-linecap="round"/>` +
        `<circle cx="372" cy="140" r="42" fill="url(#mark-big)"/></g>`
    )
  }

  /**
   * The header every diagram opens with: the mark, "Pacenote" in the gradient,
   * a title and a line of help
   */
  header(title, help) {
    this.mark(40, 34, 30)
    this.text(84, 56, 'Pacenote', {
      size: 22,
      weight: 700,
      fill: 'url(#wordmark)',
    })
    this.text(84 + 104, 56, title, { size: 22, weight: 600 })
    this.text(84, 80, help, { size: 13, fill: this.t.muted })
    return this
  }

  svg(title) {
    const { t } = this
    const defs = `<defs>
  <linearGradient id="mark" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#01ab78"/><stop offset="0.46" stop-color="#1fc289"/><stop offset="1" stop-color="#48c89c"/></linearGradient>
  <linearGradient id="mark-big" gradientUnits="userSpaceOnUse" x1="54" y1="314" x2="458" y2="198"><stop offset="0" stop-color="#01ab78"/><stop offset="0.46" stop-color="#1fc289"/><stop offset="1" stop-color="#48c89c"/></linearGradient>
  <linearGradient id="wordmark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.primary === '#007c5c' ? '#01ab78' : '#1fc289'}"/><stop offset="1" stop-color="${t.primary === '#007c5c' ? '#1fc289' : '#48c89c'}"/></linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="${t.shadow.color}" flood-opacity="${t.shadow.opacity}"/></filter>
  <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${t.faint}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
  <marker id="arrow-main" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${t.primary}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>`
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
${defs}
<rect width="${this.width}" height="${this.height}" rx="28" fill="${t.canvas}"/>
${this.parts.join('\n')}
</svg>
`
  }
}

/**
 * Slack, Pacey's layers on the desktop, the Docker sandbox, and what the
 * sandbox may reach
 */
function architecture(c) {
  c.header(
    'architecture',
    "One person's setup: Pacey runs on your Mac and reasons each answer in a disposable sandbox."
  )

  // Slack
  c.card(40, 120, 220, 300, { title: 'Slack', sub: 'Your workspace' })
  c.item(56, 176, 188, '#ops', 'A public channel')
  c.item(
    56,
    232,
    188,
    '@Pacey  check web-01',
    'A mention, in a thread or not',
    {
      mono: false,
    }
  )
  c.item(56, 288, 188, 'Socket Mode', 'Events over a WebSocket')
  c.item(56, 344, 188, 'Web API', 'Replies, edits, files')

  // The Mac. Pacey's layers, in the order a mention goes through them.
  c.card(320, 120, 410, 526, {
    title: 'Your Mac',
    sub: 'Pacenote.app, from Homebrew',
  })
  c.card(336, 176, 378, 284, { accent: true, radius: 14 })
  c.text(352, 200, 'Pacey', { size: 14, weight: 700, fill: c.t.primary })
  c.text(400, 200, 'the bot process, managed by the app', {
    size: 12,
    fill: c.t.muted,
  })
  const layers = [
    ['messengers/slack', 'Messenger: Slack events in, answers out'],
    ['mention pipeline', 'Who may ask, context, attachments, prompt'],
    ['reasoners/claude, codex', 'Reasoner: calls the CLI, reads its steps'],
    ['sandbox/docker', 'Sandbox: a container per request, or the host'],
  ]
  layers.forEach(([name, help], i) =>
    c.item(352, 214 + i * 52, 346, name, help)
  )
  c.chip(352, 426, 'claude@docker', { width: 108 })
  c.chip(468, 426, 'Working on it...', { tone: 'running', width: 112 })
  c.item(
    336,
    474,
    378,
    'Desktop app',
    'Status, run history, settings, menu bar',
    {
      mono: false,
    }
  )
  c.well(336, 532, 378, 98)
  c.text(352, 554, '~/.pacenote', { mono: true, size: 12, weight: 600 })
  c.text(352, 572, 'Settings and what Pacey keeps, outside the app', {
    size: 11.5,
    fill: c.t.muted,
  })
  ;['.env', 'runs/', 'logs/', 'ops-broker/'].forEach((name, i) =>
    c.text(352 + i * 84, 606, name, {
      mono: true,
      size: 11.5,
      fill: c.t.accentFg,
    })
  )

  // The sandbox: the renderer on its own, and the reasoner with its only two
  // ways out
  c.card(820, 120, 340, 526, {
    title: 'Docker sandbox',
    sub: 'pacenote-* containers, on the same Mac',
  })
  c.item(836, 176, 308, 'renderer', 'Diagrams to PNG, no network')
  c.item(
    836,
    238,
    308,
    'reasoner',
    'claude or codex, a new container per request'
  )
  c.item(836, 316, 151, 'egress-proxy', 'Allowed domains only')
  c.item(993, 316, 151, 'ops-broker', 'Credentials stay here')
  ;[
    [911, 'HTTPS'],
    [1068, 'MCP'],
  ].forEach(([x, label]) => {
    c.arrow(
      [
        [x, 284],
        [x, 314],
      ],
      {}
    )
    c.text(x + 8, 304, label, { size: 11, fill: c.t.muted })
    c.arrow(
      [
        [x, 362],
        [x, 382],
      ],
      {}
    )
  })
  c.well(836, 384, 151, 146)
  c.text(848, 404, 'Model APIs', { size: 11.5, fill: c.t.muted })
  c.chip(848, 414, 'api.anthropic.com', { width: 124 })
  c.chip(848, 442, 'chatgpt.com', { width: 92 })
  c.text(848, 486, 'and your allowlist', { size: 11.5, fill: c.t.muted })
  c.well(993, 384, 151, 146)
  c.text(1005, 404, 'Ops tools', { size: 11.5, fill: c.t.muted })
  c.chip(1005, 414, 'SSH hosts', { width: 84 })
  c.chip(1005, 442, 'k8s, read-only', { width: 112 })
  c.chip(1005, 470, 'GitHub', { width: 66 })
  c.chip(1077, 470, 'Jira', { width: 50 })
  c.chip(1005, 498, 'work directory', { width: 108 })
  c.well(836, 544, 308, 88)
  c.text(848, 564, 'Every container', { size: 11.5, fill: c.t.muted })
  const first = c.chip(848, 574, 'read-only root')
  c.chip(856 + first, 574, 'no capabilities')
  const second = c.chip(848, 602, 'internal network')
  c.chip(856 + second, 602, 'removed after use')

  // Slack and Pacey's messenger
  c.arrow(
    [
      [260, 255],
      [336, 230],
    ],
    { main: true, label: 'mention', at: [298, 240], anchor: 'middle' }
  )
  c.arrow(
    [
      [336, 252],
      [260, 362],
    ],
    { main: true, label: 'answer', at: [298, 310], anchor: 'middle' }
  )
  // The pipeline renders diagrams; the sandbox layer starts the reasoner
  c.arrow(
    [
      [714, 289],
      [836, 199],
    ],
    { dashed: true, label: 'diagrams', at: [775, 244], anchor: 'middle' }
  )
  c.arrow(
    [
      [714, 393],
      [836, 261],
    ],
    { main: true, label: 'docker run', at: [775, 327], anchor: 'middle' }
  )

  // Footer: the rules that hold everywhere
  const rules = [
    ['No public endpoint', 'Socket Mode connects outward'],
    ['Public channels only', 'Private channels and DMs are refused'],
    ['Allowed users', 'Required when ops tools are on'],
    ['Nothing leaves silently', 'The proxy allows listed domains only'],
  ]
  rules.forEach(([title, help], i) => {
    const x = 40 + i * 282
    c.card(x, 670, 266, 66, { radius: 14 })
    c.text(x + 16, 696, title, { size: 13, weight: 600 })
    c.text(x + 16, 716, help, { size: 11.5, fill: c.t.muted })
  })
}

/**
 * One Slack app for a team: the hub routes each member's mentions to their own
 * desktop
 */
function teamHub(c) {
  c.header(
    'team hub',
    "A team shares one Slack app. Each member's own Mac answers that member's mentions."
  )

  c.card(40, 120, 250, 250, {
    title: 'Slack',
    sub: 'One app for the workspace',
  })
  c.item(56, 176, 218, '@Pacey  status of web-01', 'alice asks', {
    mono: false,
  })
  c.item(56, 232, 218, '@Pacey  draft the PR', 'bob asks', { mono: false })
  c.item(56, 288, 218, '@Pacey  connect K7Q2-9DMX', 'Pairing a desktop', {
    mono: false,
  })

  c.card(360, 120, 380, 250, {
    title: 'Team hub',
    sub: 'deploy/hub: a container on a server, behind HTTPS',
  })
  c.item(
    376,
    176,
    348,
    'Holds the Slack tokens',
    'Socket Mode in, Web API out; desktops never get them',
    { mono: false }
  )
  c.item(
    376,
    232,
    348,
    'Routes by who asked',
    "A mention goes to that member's paired desktop",
    { mono: false }
  )
  c.item(
    376,
    288,
    348,
    'Calls only within a grant',
    'Each desktop may touch only the threads routed to it',
    { mono: false }
  )
  c.chip(376, 344, 'pacenote-hub', { width: 100 })
  c.chip(484, 344, 'token hashes only', { width: 124 })

  const desks = [
    ["alice's Mac", 'Her claude login, her sandbox'],
    ["bob's Mac", 'His codex login, his sandbox'],
  ]
  desks.forEach(([title, help], i) => {
    const y = 120 + i * 130
    c.card(810, y, 350, 116, { accent: true, title, sub: help })
    c.chip(828, y + 70, 'Pacenote.app', { width: 100 })
    c.chip(936, y + 70, 'Pacey answers here', { tone: 'running', width: 136 })
  })

  c.arrow(
    [
      [290, 245],
      [360, 245],
    ],
    {
      main: true,
      start: true,
      label: 'Socket Mode',
      at: [325, 228],
      anchor: 'middle',
    }
  )
  c.arrow(
    [
      [740, 200],
      [810, 178],
    ],
    { main: true, start: true }
  )
  c.arrow(
    [
      [740, 290],
      [810, 308],
    ],
    { main: true, start: true }
  )
  c.text(775, 252, 'WebSocket', {
    size: 11,
    fill: c.t.primary,
    anchor: 'middle',
    weight: 600,
  })
  c.text(775, 266, 'per desktop', {
    size: 11,
    fill: c.t.muted,
    anchor: 'middle',
  })

  // Pairing, step by step
  c.card(40, 400, 1120, 196, {
    title: 'Pairing a desktop',
    sub: 'Once per member; pairing again replaces the earlier desktop',
  })
  const steps = [
    [
      'Connect',
      'Settings > Messengers > Slack > Team hub: enter the hub URL. The app makes a token and sends only its hash.',
    ],
    [
      'A code',
      'The hub answers with a short code that expires; the app shows it.',
    ],
    [
      'In Slack',
      'The member mentions @Pacey connect <code>, so the hub learns who is pairing.',
    ],
    [
      'Confirm',
      'The app shows the Slack name it bound to; confirming stores the token in ~/.pacenote/.env.',
    ],
  ]
  steps.forEach(([title, help], i) => {
    const x = 56 + i * 274
    c.well(x, 460, 258, 120)
    c.step(x + 22, 484, String(i + 1))
    c.text(x + 42, 489, title, { size: 13, weight: 600 })
    wrap(help, 38).forEach((line, j) =>
      c.text(x + 14, 516 + j * 17, line, { size: 11.5, fill: c.t.muted })
    )
  })
}

/**
 * One mention, from the event to the answer, with what happens on failure and
 * after a restart
 */
function mentionFlow(c) {
  c.header('one mention', 'What Pacey does between a mention and its answer.')

  // Three lanes, named on the left
  const lanes = [
    ['Slack', 'The workspace', 120, 104],
    ['Pacey', 'On your Mac', 236, 132],
    ['Sandbox', 'Docker or the host', 380, 104],
  ]
  lanes.forEach(([name, help, y, h], i) => {
    c.add(
      `<rect x="40" y="${y}" width="1120" height="${h}" rx="18" fill="${i === 1 ? c.t.cardAccent : c.t.card}" filter="url(#shadow)"/>`
    )
    c.text(60, y + h / 2 - 2, name, {
      size: 14,
      weight: 700,
      fill: i === 1 ? c.t.primary : c.t.foreground,
    })
    c.text(60, y + h / 2 + 16, help, { size: 11.5, fill: c.t.muted })
  })

  const W = 150
  const steps = [
    {
      n: '1',
      lane: 0,
      x: 160,
      title: 'app_mention',
      help: ['Acked; a redelivery', 'is handled once'],
    },
    {
      n: '2',
      lane: 1,
      x: 160,
      title: 'Allowed here?',
      help: ['Allowed users,', 'public channels only'],
    },
    {
      n: '3',
      lane: 0,
      x: 330,
      title: 'Working on it...',
      help: ['The placeholder,', 'posted first'],
    },
    {
      n: '4',
      lane: 1,
      x: 330,
      title: 'Read the thread',
      help: ['Names, text,', 'images, PDFs'],
    },
    {
      n: '5',
      lane: 2,
      x: 500,
      title: 'Reason',
      help: ['claude or codex,', 'tools over MCP'],
    },
    {
      n: '6',
      lane: 1,
      x: 670,
      title: 'Record',
      help: ['Each step into', 'runs/, as it happens'],
    },
    {
      n: '7',
      lane: 2,
      x: 840,
      title: 'Render',
      help: ['Diagram blocks to', 'PNG, no network'],
    },
    {
      n: '8',
      lane: 0,
      x: 1000,
      title: 'Answer',
      help: ['Edits the placeholder', 'and uploads images'],
    },
  ]
  const laneY = [138, 262, 398]
  steps.forEach((s) => {
    const y = laneY[s.lane]
    c.well(s.x, y, W, 68)
    c.step(s.x + 20, y + 20, s.n)
    c.text(s.x + 38, y + 25, s.title, { size: 12.5, weight: 600 })
    s.help.forEach((line, i) =>
      c.text(s.x + 14, y + 44 + i * 15, line, { size: 11.5, fill: c.t.muted })
    )
  })
  // Down within a column, then elbows between columns
  const right = (s) => s.x + W
  const mid = (s) => laneY[s.lane] + 34
  const down = (a, b) =>
    c.arrow(
      [
        [a.x + 75, laneY[a.lane] + 68],
        [b.x + 75, laneY[b.lane]],
      ],
      { main: true }
    )
  const elbow = (a, b) =>
    c.arrow(
      [
        [right(a), mid(a)],
        [right(a) + 10, mid(a)],
        [right(a) + 10, mid(b)],
        [b.x, mid(b)],
      ],
      { main: true }
    )
  down(steps[0], steps[1])
  elbow(steps[1], steps[2])
  down(steps[2], steps[3])
  elbow(steps[3], steps[4])
  elbow(steps[4], steps[5])
  elbow(steps[5], steps[6])
  elbow(steps[6], steps[7])

  // What can go another way
  const others = [
    {
      tone: 'failed',
      title: 'Not allowed or not public',
      help: 'A note only the asker sees; nothing runs.',
    },
    {
      tone: 'failed',
      title: 'The reasoner fails',
      help: '"I couldn\'t produce an answer." in the placeholder; the cause stays in the log.',
    },
    {
      tone: 'interrupted',
      title: 'Pacey restarts',
      help: 'inflight.json resumes it once in the same message: "I restarted..."',
    },
    {
      tone: 'running',
      title: 'Too many at once',
      help: 'Two run, ten wait; beyond that Pacey says it is busy.',
    },
  ]
  others.forEach((o, i) => {
    const x = 40 + i * 282
    c.card(x, 512, 266, 100, { radius: 14 })
    c.add(
      `<rect x="${x + 16}" y="532" width="6" height="60" rx="3" fill="${c.t[o.tone]}"/>`
    )
    c.text(x + 32, 546, o.title, { size: 13, weight: 600 })
    wrap(o.help, 34).forEach((line, j) =>
      c.text(x + 32, 566 + j * 16, line, { size: 11.5, fill: c.t.muted })
    )
  })
}

/**
 * The code: the mention pipeline talks to chat apps only through the messenger
 * interface
 */
function codeLayout(c) {
  c.header(
    'code layout',
    'Where things live in the repository, and the one interface every chat app goes through.'
  )

  // Entry
  c.card(40, 120, 260, 120, { title: 'src/index.ts', sub: 'Assembles the bot' })
  c.text(58, 192, 'Connects the messenger, starts', {
    size: 11.5,
    fill: c.t.muted,
  })
  c.text(58, 208, 'the responder, the sandbox checks', {
    size: 11.5,
    fill: c.t.muted,
  })
  c.text(58, 224, 'and the status file', { size: 11.5, fill: c.t.muted })

  // Messengers
  c.card(40, 266, 260, 330, {
    title: 'src/messengers/slack',
    sub: 'The Slack adapter',
  })
  ;[
    ['connect.ts', 'Bolt, Socket Mode or the hub'],
    ['messenger.ts', 'SlackMessenger'],
    ['files.ts', 'Lookups, downloads'],
    ['format.ts', 'Markdown to mrkdwn'],
    ['directory.ts', 'Names, channels'],
  ].forEach(([name, help], i) => c.item(56, 322 + i * 52, 228, name, help))

  // The interface
  c.card(350, 120, 330, 476, {
    accent: true,
    title: 'Messenger',
    sub: 'src/messengers/types.ts',
  })
  const methods = [
    ['venue / request / context', 'Where, what, and the thread so far'],
    ['resolveFiles / download', 'Attachments'],
    ['notice / post / update', 'Replies, edits, notes to the asker'],
    ['upload', 'Generated images, diagrams'],
    ['render', "Markdown into the app's markup"],
    ['permalink', 'Links in the run history'],
  ]
  methods.forEach(([name, help], i) =>
    c.item(366, 176 + i * 54, 298, name, help)
  )
  c.chip(366, 508, 'Mention: plain JSON, resumable', { width: 214 })
  c.text(366, 552, 'A new chat app is a new adapter;', {
    size: 11.5,
    fill: c.t.muted,
  })
  c.text(366, 569, 'the pipeline does not change.', {
    size: 11.5,
    fill: c.t.muted,
  })

  // Pipeline
  c.card(730, 120, 430, 228, {
    title: 'src/mention',
    sub: 'The pipeline, messenger-neutral',
  })
  ;[
    ['responder.ts', 'One mention end to end'],
    ['prompt.ts', 'System and user prompts'],
    ['attachments.ts', 'What to read, and reading it'],
    ['inflight.ts', 'Resume after a restart'],
  ].forEach(([name, help], i) =>
    c.item(746 + (i % 2) * 202, 176 + Math.floor(i / 2) * 54, 194, name, help)
  )
  c.item(746, 284, 194, 'limiter.ts', 'Concurrency, queue')
  c.item(948, 284, 196, 'run-record.ts', 'Into the history')

  // Below the pipeline
  const below = [
    ['src/reasoners', 'An adapter per CLI'],
    ['src/sandbox', 'Where it runs: host, docker'],
    ['src/history', 'runs/ written and read'],
    ['src/hub, src/broker', 'Team hub; ops tools'],
  ]
  below.forEach(([name, help], i) => {
    const x = 730 + (i % 2) * 218
    const y = 368 + Math.floor(i / 2) * 76
    c.card(x, y, 212, 64, { radius: 14 })
    c.text(x + 16, y + 26, name, { mono: true, size: 12, weight: 600 })
    c.text(x + 16, y + 46, help, { size: 11.5, fill: c.t.muted })
  })

  c.arrow(
    [
      [300, 380],
      [350, 380],
    ],
    { main: true, label: 'implements', at: [325, 364], anchor: 'middle' }
  )
  c.arrow(
    [
      [680, 250],
      [730, 250],
    ],
    { main: true, start: true, label: 'uses', at: [705, 234], anchor: 'middle' }
  )
  c.arrow(
    [
      [170, 240],
      [170, 266],
    ],
    {}
  )

  // Apps
  c.card(40, 616, 1120, 72, { radius: 14 })
  c.text(60, 646, 'apps/desktop', { mono: true, size: 12.5, weight: 600 })
  c.text(
    60,
    666,
    'Electron: supervises Pacey, settings store, sandbox jobs, menu bar',
    {
      size: 11.5,
      fill: c.t.muted,
    }
  )
  c.text(620, 646, 'apps/web', { mono: true, size: 12.5, weight: 600 })
  c.text(
    620,
    666,
    'React UI over pacenote://app: status, run history, settings',
    {
      size: 11.5,
      fill: c.t.muted,
    }
  )
}

/**
 * The three interfaces around the mention pipeline, what implements each today,
 * and where the next ones go
 */
function layers(c) {
  c.header(
    'layers',
    "Three interfaces keep the pipeline apart from the chat app, the model's CLI, and where it runs."
  )
  const W = 232
  const GAP = 64
  const TOP = 120
  const H = 516
  const left = (i) => 40 + i * (W + GAP)
  const columns = [
    {
      title: 'Messenger',
      sub: 'src/messengers/types.ts',
      accent: true,
      upper: 'Interface',
      contract: [
        ['venue / request', 'Where, and what was asked'],
        ['context / download', 'The thread, attachments'],
        ['post / update / upload', 'Answers, edits, images'],
        ['render', "Markdown in the app's markup"],
      ],
      lower: 'Adapters',
      adapters: [['slack/', 'Bolt, Socket Mode or the hub']],
      slots: ['Telegram', 'Discord'],
    },
    {
      title: 'Mention pipeline',
      sub: 'src/mention',
      upper: 'Messenger- and model-neutral',
      contract: [
        ['responder.ts', 'One mention end to end'],
        ['prompt.ts', 'System and user prompts'],
        ['attachments.ts', 'What to read, and reading it'],
        ['limiter.ts', 'Concurrency, the queue'],
      ],
      lower: 'Around it',
      adapters: [
        ['src/index.ts', 'Picks one of each'],
        ['src/history', 'Runs and their steps'],
      ],
      slots: [],
    },
    {
      title: 'Reasoner',
      sub: 'src/reasoners/types.ts',
      accent: true,
      upper: 'Interface',
      contract: [
        ['complete(request)', 'Prompt in, the answer out'],
        ['onEvent', 'Steps for the run history'],
        ['canReadFiles', 'Whether it may read files'],
        ['CliAdapter', 'invocation, events, answer'],
      ],
      lower: 'Adapters',
      adapters: [
        ['claude.ts', 'claude -p, stream-json'],
        ['codex.ts', 'codex exec --json'],
      ],
      slots: ['Another CLI (gemini, ...)', 'An API reasoner'],
    },
    {
      title: 'Sandbox',
      sub: 'src/sandbox/runtime.ts',
      accent: true,
      upper: 'Interface',
      contract: [
        ['run(SandboxRun)', 'One process: env, mounts, stdin'],
        ['pathIn(mount, file)', 'Paths as the process sees them'],
        ['extractPdfText', 'Uploaded PDFs, no network'],
        ['verify()', 'What keeps it from running'],
      ],
      lower: 'Implementations',
      adapters: [
        ['host.ts', 'Your login, no isolation'],
        ['docker.ts', 'Hardened, one per request'],
      ],
      slots: ['Podman', 'A VM or a remote runner'],
    },
  ]

  columns.forEach((col, i) => {
    const x = left(i)
    c.card(x, TOP, W, H, { accent: col.accent, title: col.title, sub: col.sub })
    c.text(x + 18, TOP + 80, col.upper, { size: 11.5, fill: c.t.muted })
    col.contract.forEach(([name, help], j) =>
      c.item(x + 16, TOP + 90 + j * 54, W - 32, name, help)
    )
    c.text(x + 18, TOP + 326, col.lower, { size: 11.5, fill: c.t.muted })
    col.adapters.forEach(([name, help], j) =>
      c.item(x + 16, TOP + 336 + j * 54, W - 32, name, help, {
        labelFill: c.t.primary,
      })
    )
    col.slots.forEach((label, j) =>
      c.slot(x + 16, TOP + 444 + j * 34, W - 32, label)
    )
  })

  // What crosses each interface, there and back
  const pairs = [
    ['mention', 'answer'],
    ['request', 'answer'],
    ['process', 'stdout'],
  ]
  pairs.forEach(([there, back], i) => {
    const from = left(i) + W
    const to = left(i + 1)
    const mid = (from + to) / 2
    c.arrow(
      [
        [from, TOP + 170],
        [to, TOP + 170],
      ],
      { main: true, label: there, at: [mid, TOP + 156], anchor: 'middle' }
    )
    c.arrow(
      [
        [to, TOP + 226],
        [from, TOP + 226],
      ],
      { label: back, at: [mid, TOP + 212], anchor: 'middle' }
    )
  })

  // How each kind of new thing gets in
  const adding = [
    [
      'A chat app',
      [
        'An adapter in src/messengers',
        'and its settings section. The',
        'pipeline does not change.',
      ],
    ],
    [
      'Settings',
      [
        "REASONER picks the model's",
        'adapter, REASONER_SANDBOX',
        'the sandbox: host or docker.',
      ],
    ],
    [
      'A model',
      [
        'An adapter in src/reasoners and',
        'its id in ids.ts; the CLI goes',
        'into the reasoner image.',
      ],
    ],
    [
      'A runtime',
      [
        'A Sandbox in src/sandbox.',
        'Adapters ask for mounts and',
        'env, never for docker.',
      ],
    ],
  ]
  adding.forEach(([title, lines], i) => {
    const x = left(i)
    const y = TOP + H + 24
    c.card(x, y, W, 98, { radius: 14 })
    c.text(x + 16, y + 26, title, { size: 13, weight: 600 })
    lines.forEach((line, j) =>
      c.text(x + 16, y + 48 + j * 17, line, { size: 11.5, fill: c.t.muted })
    )
  })
}

/** Splits text into lines of at most `width` characters */
function wrap(text, width) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

const DIAGRAMS = [
  ['architecture', 'Pacenote architecture', 1200, 760, architecture],
  ['team-hub', 'Pacenote team hub', 1200, 628, teamHub],
  ['mention-flow', 'Pacenote: one mention', 1200, 640, mentionFlow],
  ['layers', 'Pacenote layers', 1200, 800, layers],
  ['code-layout', 'Pacenote code layout', 1200, 720, codeLayout],
]

mkdirSync(OUT, { recursive: true })
for (const [name, title, width, height, draw] of DIAGRAMS) {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const canvas = new Canvas(tokens, width, height)
    draw(canvas)
    const file = path.join(OUT, `${name}-${theme}.svg`)
    writeFileSync(file, canvas.svg(title))
    console.log(path.relative(process.cwd(), file))
  }
}
