import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO } from './support/processes.js'
import { World } from './support/world.js'

/**
 * The desktop app as a member uses it, driven through its window: first run,
 * Slack tokens in Settings, starting the bot, a mention answered, and the run
 * in the history. Needs a build (pnpm desktop:build), so it runs only with
 * E2E_APP=1 (pnpm test:e2e:app). The window opens on screen while it runs.
 */

const ELECTRON = createRequire(path.join(REPO, 'apps/desktop/package.json'))(
  'electron'
) as unknown as string

let world: World | undefined
let app: ElectronApplication | undefined
afterEach(async (context) => {
  // A failed step leaves a screenshot of the window behind (the path is in the
  // error output).
  if (context.task.result?.state === 'fail' && app) {
    const file = path.join(
      REPO,
      'test-results',
      `${context.task.name.replace(/\W+/g, '-')}.png`
    )
    mkdirSync(path.dirname(file), { recursive: true })
    await (
      await app.firstWindow()
    )
      .screenshot({ path: file })
      .catch(() => undefined)
    console.error(`Screenshot: ${file}`)
  }
  await app?.close()
  app = undefined
  await world?.stop()
  world = undefined
})

async function launch(world: World): Promise<Page> {
  // What a member would have set before: everything except the Slack tokens,
  // which the test enters in Settings.
  mkdirSync(world.home, { recursive: true })
  writeFileSync(
    path.join(world.home, '.env'),
    [
      'REASONER=claude',
      'REASONER_SANDBOX=none',
      'RENDER_DIAGRAMS=off',
      'TIMEZONE=UTC',
      `SLACK_API_URL=${world.slack.apiUrl}`,
      `CLAUDE_BIN=${world.claudeBin}`,
      `FAKE_CLAUDE_DIR=${world.claudeDir}`,
      '',
    ].join('\n')
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(PACENOTE|ORBLY|VERDA|SLACK|HUB)_/.test(entry[0])
    )
  )
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: [path.join(REPO, 'apps/desktop')],
    env: {
      ...env,
      // Its own HOME, so the bot lock does not see a real Pacenote, Orbly or
      // Verda running from its home.
      HOME: world.root,
      PACENOTE_HOME: world.home,
      PACENOTE_DATA_DIR: world.home,
      PACENOTE_DESKTOP_USER_DATA: path.join(world.root, 'user-data'),
      PACENOTE_DESKTOP_THEME: 'light',
    },
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function enterSecret(
  page: Page,
  key: string,
  value: string,
  submit: 'enter' | 'click'
) {
  const row = page.locator(`[data-setting="${key}"]`)
  await row.getByRole('button', { name: /^(Enter|Change)$/ }).click()
  await row.locator('input[type="password"]').fill(value)
  if (submit === 'enter')
    await row.locator('input[type="password"]').press('Enter')
  else await row.getByRole('button', { name: 'Save', exact: true }).click()
}

describe.runIf(process.env.E2E_APP)('desktop app', () => {
  it('sets up Slack from a first run, starts the bot, and shows the answered mention', async () => {
    world = await World.create([
      { match: 'web-01', answer: '**Healthy**. Up 3 days.' },
    ])
    const { slack, ops, alice } = world
    const page = await launch(world)

    // A first run has no Slack tokens: the bot waits for setup and the status
    // bar says so.
    await page.getByText('Pace: Setup needed').waitFor()
    await page.getByRole('button', { name: 'Open Settings' }).first().click()
    await page.getByRole('heading', { name: 'Messengers' }).waitFor()

    // Each token is saved on its own, from beside its input.
    await enterSecret(page, 'SLACK_APP_TOKEN', slack.appToken, 'enter')
    await page
      .getByText('Saved the app token. Enter the bot token next.')
      .waitFor()
    await enterSecret(page, 'SLACK_BOT_TOKEN', slack.botToken, 'click')
    await page.getByText('Saved the bot token. Start Pace to use it.').waitFor()
    expect(
      await page.locator('[data-setting="SLACK_BOT_TOKEN"]').textContent()
    ).toContain('xoxb-...-bot')

    // The connection check runs against the same Slack the bot will use.
    await page.getByRole('button', { name: 'Check connection' }).click()
    await page.getByText('Socket Mode', { exact: true }).waitFor()

    await page.getByRole('button', { name: 'Start Pace' }).click()
    await page.getByText(/Pace: Connected/).waitFor({ timeout: 30_000 })

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> how is web-01?`,
    })
    const [reply] = await world.answered(ops.id, ts)
    expect(reply!.text).toBe('*Healthy*. Up 3 days.')

    // The run shows up in the history with the answer and a link back to Slack.
    await page.evaluate("window.location.hash = '#/'")
    await page.getByText('how is web-01?').first().click({ timeout: 15_000 })
    await page.getByText('Up 3 days.').first().waitFor()
    const link = page.getByRole('link', { name: 'View in Slack' })
    expect(await link.getAttribute('href')).toBe(
      `${slack.url}/archives/${ops.id}/p${reply!.ts.replace('.', '')}?thread_ts=${ts}&cid=${ops.id}`
    )
  })
})
