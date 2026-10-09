import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  InflightStore,
  MAX_ATTEMPTS,
  MAX_RESUME_AGE_MS,
  resumeDecision,
  type InflightEntry,
} from '../src/mention/inflight.js'

const dir = mkdtempSync(path.join(tmpdir(), 'inflight-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const entry = (
  key: string,
  extra: Partial<InflightEntry> = {}
): InflightEntry => ({
  key,
  mention: {
    messenger: 'slack',
    conversation: 'C1',
    message: '1.0',
    thread: '1.0',
    inThread: false,
    userId: 'U1',
    text: '<@UBOT> draw it',
    files: [],
  },
  label: '#general',
  placeholder: '1.1',
  attempts: 1,
  startedAt: 1_000_000,
  ...extra,
})

describe('InflightStore', () => {
  it('records and removes requests', () => {
    const store = new InflightStore(path.join(dir, 'a', 'inflight.json'))
    expect(store.list()).toEqual([])
    store.upsert(entry('C1:1.0'))
    store.upsert(entry('C1:2.0'))
    store.upsert(entry('C1:1.0', { attempts: 2 }))
    expect(store.list().map((e) => [e.key, e.attempts])).toEqual([
      ['C1:2.0', 1],
      ['C1:1.0', 2],
    ])
    store.remove('C1:2.0')
    expect(store.list().map((e) => e.key)).toEqual(['C1:1.0'])
  })

  it('reads entries written before messengers existed as Slack mentions', () => {
    const file = path.join(dir, 'v02.json')
    writeFileSync(
      file,
      JSON.stringify([
        {
          key: 'C1:2.0',
          event: {
            channel: 'C1',
            ts: '2.0',
            thread_ts: '1.0',
            user: 'U1',
            text: '<@UBOT> check',
            files: [
              {
                id: 'F1',
                name: 'app.log',
                mimetype: 'text/plain',
                url_private_download: 'u',
              },
            ],
          },
          threadTs: '1.0',
          label: '#ops',
          placeholderTs: '2.1',
          runId: 'r1',
          attempts: 1,
          startedAt: 5,
        },
      ])
    )
    expect(new InflightStore(file).list()).toEqual([
      {
        key: 'slack:C1:2.0',
        mention: {
          messenger: 'slack',
          conversation: 'C1',
          message: '2.0',
          thread: '1.0',
          inThread: true,
          userId: 'U1',
          text: '<@UBOT> check',
          files: [
            expect.objectContaining({ id: 'F1', name: 'app.log', handle: 'u' }),
          ],
        },
        label: '#ops',
        placeholder: '2.1',
        runId: 'r1',
        attempts: 1,
        startedAt: 5,
      },
    ])
  })

  it('treats a corrupt file as an empty list', () => {
    const file = path.join(dir, 'broken.json')
    writeFileSync(file, '{not json')
    expect(new InflightStore(file).list()).toEqual([])
  })
})

describe('resumeDecision', () => {
  it('resumes only once and gives up on old requests', () => {
    const now = 1_000_000 + 60_000
    expect(resumeDecision(entry('k', { attempts: 1 }), now)).toBe('resume')
    expect(resumeDecision(entry('k', { attempts: MAX_ATTEMPTS }), now)).toBe(
      'give_up'
    )
    expect(resumeDecision(entry('k'), 1_000_000 + MAX_RESUME_AGE_MS + 1)).toBe(
      'give_up'
    )
  })
})
