import { describe, expect, it } from 'vitest'
import { ConcurrencyLimiter } from '../src/mention/limiter.js'
import { systemPrompt, userPrompt } from '../src/mention/prompt.js'
import { isAllowedUser } from '../src/mention/responder.js'
import { stripBotMention } from '../src/messengers/slack/format.js'
import type { MessengerProfile } from '../src/messengers/types.js'

const slack: MessengerProfile = {
  name: 'Slack',
  venues: 'public channels',
  markup: 'Slack mrkdwn',
  public: true,
}

describe('stripBotMention', () => {
  it('removes only the bot mention and keeps other mentions', () => {
    expect(
      stripBotMention("<@UBOT> what is the review status of <@U1>'s PR", 'UBOT')
    ).toBe("what is the review status of <@U1>'s PR")
    expect(stripBotMention('<@UBOT|agent>  ', 'UBOT')).toBe('')
  })
})

describe('isAllowedUser', () => {
  it('allows everyone when the list is empty, otherwise only listed users', () => {
    expect(isAllowedUser('U1', [])).toBe(true)
    expect(isAllowedUser('U1', ['U1'])).toBe(true)
    expect(isAllowedUser('U2', ['U1'])).toBe(false)
  })
})

describe('systemPrompt', () => {
  it('adds file lookup instructions only when there is a reference directory', () => {
    expect(systemPrompt(slack)).not.toContain('working directory')
    expect(systemPrompt(slack, { canReadWorkspace: true })).toContain(
      'working directory'
    )
    expect(systemPrompt(slack)).toContain(
      '<thread> is conversation context for reference'
    )
    expect(systemPrompt(slack)).toContain(
      'Reply in the language of the conversation.'
    )
  })

  it('describes the messenger the mention came from', () => {
    expect(systemPrompt(slack)).toContain(
      'You are Pace, a work assistant that answers mentions in Slack public channels.'
    )
    expect(systemPrompt(slack)).toContain('Use Slack mrkdwn')
    expect(systemPrompt(slack)).toContain('do not put secrets')
    expect(systemPrompt({ ...slack, public: false })).not.toContain(
      'do not put secrets'
    )
  })
})

describe('userPrompt', () => {
  it('puts the conversation, then the request, then the attachments', () => {
    expect(
      userPrompt({
        venue: '#ops',
        context: ['10/08, 14:20 @bob: Could someone check?'],
        author: '@alice',
        request: 'check web-01',
        attachments: ['', '<attachments>', '</attachments>'],
      })
    ).toBe(
      [
        '<thread venue="#ops">',
        '10/08, 14:20 @bob: Could someone check?',
        '</thread>',
        '',
        '<request from="@alice">',
        'check web-01',
        '</request>',
        '',
        '<attachments>',
        '</attachments>',
      ].join('\n')
    )
  })
})

describe('ConcurrencyLimiter', () => {
  it('enforces the concurrency and queue limits', async () => {
    const limiter = new ConcurrencyLimiter(1, 1)
    const releases: (() => void)[] = []
    let running = 0
    let maxRunning = 0
    const task = () =>
      new Promise<void>((resolve) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        releases.push(() => {
          running -= 1
          resolve()
        })
      })

    expect(limiter.tryRun(task)).toBe(true) // runs
    expect(limiter.tryRun(task)).toBe(true) // queued
    expect(limiter.tryRun(task)).toBe(false) // full
    expect(releases).toHaveLength(1)

    releases.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(releases).toHaveLength(1) // the queued task starts
    releases.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(maxRunning).toBe(1)
  })
})
