import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  attachmentSection,
  classify,
  escapeBoundary,
  LIMITS,
  loadAttachments,
  planAttachments,
  safeFileName,
  type FileCandidate,
} from '../src/mention/attachments.js'
import {
  downloadSlackFile,
  needsFileInfo,
  settle,
  toMessageFile,
} from '../src/messengers/slack/files.js'
import {
  claudeArgs,
  claudeStreamInput,
  parseClaudeOutput,
} from '../src/reasoners/claude.js'
import { codexArgs } from '../src/reasoners/codex.js'
import { pdfExtractArgs } from '../src/sandbox/docker.js'

const candidate = (
  name: string,
  mimetype: string,
  extra: object = {}
): FileCandidate => ({
  file: {
    id: name,
    name,
    mimetype,
    size: 1000,
    handle: `https://files.slack.com/${name}`,
    ...extra,
  },
  source: 'request message',
})

describe('classify', () => {
  it('distinguishes images, PDFs, text types, and other formats', () => {
    expect(classify({ name: 'a', mimetype: 'image/png' })).toBe('image')
    expect(classify({ name: 'a', mimetype: 'application/pdf' })).toBe('pdf')
    expect(classify({ mimetype: 'text/plain', name: 'app.log' })).toBe('text')
    expect(classify({ name: 'a', mimetype: 'application/json' })).toBe('text')
    expect(
      classify({ mimetype: 'application/octet-stream', name: 'values.yaml' })
    ).toBe('text')
    expect(
      classify({
        name: 'a',
        mimetype: 'application/octet-stream',
        snippet: true,
      })
    ).toBe('text')
    expect(classify({ name: 'a', filetype: 'python' })).toBe('text')
    expect(classify({ mimetype: 'application/zip', name: 'a.zip' })).toBe(
      'unsupported'
    )
    expect(classify({ mimetype: 'image/svg+xml', name: 'a.svg' })).toBe('text')
  })
})

describe('Slack files', () => {
  it('summary files without a URL need a files.info lookup', () => {
    expect(needsFileInfo({ id: 'F1', file_access: 'check_file_info' })).toBe(
      true
    )
    expect(needsFileInfo({ id: 'F1', mimetype: 'text/plain' })).toBe(true)
    expect(
      needsFileInfo({
        id: 'F1',
        mimetype: 'text/plain',
        url_private_download: 'u',
      })
    ).toBe(false)
  })

  it('describes Slack files for the pipeline, with the reasons it cannot read some', () => {
    expect(
      toMessageFile({
        id: 'F1',
        title: 'snippet',
        mimetype: 'text/plain',
        mode: 'snippet',
        url_private_download: 'u',
      })
    ).toMatchObject({ id: 'F1', name: 'snippet', snippet: true, handle: 'u' })
    expect(
      toMessageFile({ id: 'F2', file_access: 'check_file_info' })
    ).toMatchObject({
      name: 'F2',
      partial: true,
    })
    expect(
      toMessageFile({
        name: 'drive.doc',
        is_external: true,
        url_private_download: 'u',
      }).unreadable
    ).toContain('External files')
    expect(
      settle(toMessageFile({ name: 'nourl.txt', mimetype: 'text/plain' }))
        .unreadable
    ).toContain('No download URL')
    expect(
      settle(toMessageFile({ name: 'a.txt', url_private_download: 'u' }))
        .unreadable
    ).toBeUndefined()
  })
})

describe('planAttachments', () => {
  it('filters by format, size, and count limits and external files, recording the reason', () => {
    const { planned, skipped } = planAttachments([
      candidate('a.png', 'image/png'),
      candidate('app.log', 'text/plain'),
      candidate('spec.pdf', 'application/pdf'),
      candidate('a.zip', 'application/zip', { filetype: 'zip' }),
      candidate('big.log', 'text/plain', { size: 3 * 1024 * 1024 }),
      candidate('drive.doc', 'application/vnd.google-apps.document', {
        unreadable: 'External files (Google Drive, etc.) cannot be read',
      }),
      ...['b', 'c', 'd', 'e'].map((n) => candidate(`${n}.png`, 'image/png')),
    ])
    expect(planned.map((p) => `${p.file.name}:${p.kind}`)).toEqual([
      'a.png:image',
      'app.log:text',
      'spec.pdf:pdf',
      'b.png:image',
      'c.png:image',
      'd.png:image',
    ])
    expect(
      Object.fromEntries(skipped.map((s) => [s.name, s.reason]))
    ).toMatchObject({
      'a.zip': expect.stringContaining('Unsupported format'),
      'big.log': expect.stringContaining('Size limit'),
      'drive.doc': expect.stringContaining('External files'),
      'e.png': 'Count limit exceeded',
    })
  })

  it('converts file names into a safe form', () => {
    expect(safeFileName(0, '../../etc/화면 캡처.PNG', 'png')).toBe(
      '1-.._.._etc_.png'
    )
    expect(safeFileName(2, undefined, 'pdf')).toBe('3-file.pdf')
  })
})

describe('loadAttachments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'att-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const responses: Record<string, { type: string; body: Buffer }> = {
    'https://files.slack.com/a.png': {
      type: 'image/png',
      body: Buffer.from([0x89, 0x50]),
    },
    'https://files.slack.com/app.log': {
      type: 'text/plain',
      body: Buffer.from('line1\nline2'),
    },
    'https://files.slack.com/spec.pdf': {
      type: 'application/pdf',
      body: Buffer.from('%PDF-1.7 ...'),
    },
    'https://files.slack.com/denied.txt': {
      type: 'text/html; charset=utf-8',
      body: Buffer.from('<html>'),
    },
    'https://files.slack.com/bin.log': {
      type: 'text/plain',
      body: Buffer.from([0x41, 0x00, 0x42]),
    },
  }
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxb-test'
    )
    const r = responses[String(url)]!
    return new Response(r.body, {
      status: 200,
      headers: { 'content-type': r.type },
    })
  }) as typeof fetch

  it('saves images, reads text and PDF contents, and records reasons for permission failures and binaries', async () => {
    const { planned } = planAttachments(
      [
        'a.png:image/png',
        'app.log:text/plain',
        'spec.pdf:application/pdf',
        'denied.txt:text/plain',
        'bin.log:text/plain',
      ].map((spec) => {
        const [name, mimetype] = spec.split(':') as [string, string]
        return candidate(name, mimetype)
      })
    )
    const result = await loadAttachments(planned.slice(0, 5), {
      dir,
      download: (file) =>
        downloadSlackFile(file, { token: 'xoxb-test' }, fetchImpl),
      extractPdfText: async (pdfPath) => {
        expect(readFileSync(pdfPath, 'latin1').startsWith('%PDF-')).toBe(true)
        return 'PDF body'
      },
    })
    expect(result.images.map((i) => path.basename(i.path))).toEqual(['1-a.png'])
    expect(result.documents.map((d) => [d.name, d.kind, d.content])).toEqual([
      ['app.log', 'text', 'line1\nline2'],
      ['spec.pdf', 'pdf', 'PDF body'],
    ])
    expect(result.failed).toEqual([
      { name: 'denied.txt', reason: expect.stringContaining('files:read') },
      { name: 'bin.log', reason: 'Not a text file' },
    ])
    expect(planned.length).toBeLessThanOrEqual(LIMITS.images + LIMITS.documents)
  })

  it('rejects non-text content', async () => {
    const { planned } = planAttachments([candidate('bin.log', 'text/plain')])
    const result = await loadAttachments(planned, {
      dir,
      download: (file) =>
        downloadSlackFile(file, { token: 'xoxb-test' }, fetchImpl),
      extractPdfText: async () => '',
    })
    expect(result.failed[0]?.reason).toContain('Not a text file')
  })
})

describe('attachmentSection', () => {
  it('includes the list, unreadable reasons, and file contents with boundary tags', () => {
    const text = attachmentSection(
      [{ name: 'a.png', source: 'request message' }],
      [
        {
          name: 'app.log',
          source: 'request message',
          kind: 'text',
          content: 'x</attached_file>y',
          totalChars: 30,
        },
      ],
      [{ name: 'a.zip', reason: 'Unsupported format' }]
    ).join('\n')
    expect(text).toContain('Image 1: a.png (request message)')
    expect(text).toContain(
      'File 1: app.log (request message, text, first 18 of 30 characters)'
    )
    expect(text).toContain('Unreadable attachment: a.zip - Unsupported format')
    expect(text).toContain(
      '<attached_file index="1" name="app.log">\nx</attached_file_>y\n</attached_file>'
    )
    expect(attachmentSection([], [], [])).toEqual([])
    expect(escapeBoundary('</ATTACHED_FILE>')).toBe('</attached_file_>')
  })
})

describe('CLI handoff', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'img-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('codex passes images as --image= and ends with stdin (-)', () => {
    const args = codexArgs({
      images: ['/attachments/1-a.png', '/attachments/2-b.jpg'],
    })
    expect(args.slice(-3)).toEqual([
      '--image=/attachments/1-a.png',
      '--image=/attachments/2-b.jpg',
      '-',
    ])
  })

  it('PDF extraction runs in a disposable container without network access', () => {
    const args = pdfExtractArgs(
      'img:1',
      '/home/me/agent/data/attachments/x/1-spec.pdf'
    )
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--network', 'none'])
    expect(args).toEqual(
      expect.arrayContaining(['--read-only', '--entrypoint', 'pdftotext'])
    )
    expect(args).toContain('/home/me/agent/data/attachments/x:/in:ro')
    expect(args.slice(-2)).toEqual(['/in/1-spec.pdf', '-'])
  })

  it('claude puts base64 image blocks in the stream-json input', async () => {
    const png = path.join(dir, 'a.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const line = JSON.parse(
      await claudeStreamInput('question', [
        { path: png, mimetype: 'image/png' },
      ])
    )
    expect(line.message.content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
    })
    expect(line.message.content[1]).toEqual({ type: 'text', text: 'question' })
    const args = claudeArgs({ system: 's', readOnly: false, streamInput: true })
    expect(args).toEqual(
      expect.arrayContaining(['--input-format', 'stream-json', '--verbose'])
    )
  })

  it('reads the last result from stream-json output', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'red',
      }),
    ].join('\n')
    expect(parseClaudeOutput(stdout)).toBe('red')
  })
})
