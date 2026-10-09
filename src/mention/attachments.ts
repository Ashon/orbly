import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Download, MessageFile } from '../messengers/types.js'

/**
 * Turns mention/thread attachments into model input, for any messenger (it
 * supplies the download).
 * - Images: saved as files and passed to the CLI as images.
 * - Text (logs, config, code, snippets): the content goes into the prompt as
 *   data.
 * - PDF: only the text is extracted, in a container without network access.
 * - Other formats, files the messenger cannot give out: reports why they could
 *   not be read.
 */

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export const LIMITS = {
  images: 4,
  documents: 4,
  imageBytes: 10 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  charsPerDocument: 50_000,
  charsTotal: 120_000,
}

const TEXT_MIME = new Set([
  'application/json',
  'application/x-ndjson',
  'application/x-yaml',
  'application/yaml',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-shellscript',
  'application/toml',
  'application/sql',
  'application/x-python',
  'image/svg+xml',
])

const TEXT_FILETYPES = new Set([
  'text',
  'markdown',
  'json',
  'yaml',
  'csv',
  'tsv',
  'log',
  'shell',
  'bash',
  'python',
  'javascript',
  'typescript',
  'go',
  'rust',
  'java',
  'kotlin',
  'c',
  'cpp',
  'csharp',
  'diff',
  'patch',
  'sql',
  'xml',
  'html',
  'css',
  'toml',
  'ini',
  'dockerfile',
  'makefile',
  'ruby',
  'php',
  'swift',
  'scala',
  'perl',
  'lua',
  'groovy',
  'properties',
  'terraform',
])

const TEXT_EXTENSION =
  /\.(txt|log|out|md|json|jsonl|ya?ml|csv|tsv|conf|cfg|ini|toml|sh|bash|py|js|mjs|ts|go|rs|java|kt|c|h|cc|cpp|hpp|sql|xml|html|css|diff|patch|properties|tf|hcl|jsonnet|libsonnet|j2|tpl|service|svg)$/i

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'unsupported'

export interface FileCandidate {
  file: MessageFile
  /**
   * Source shown in the prompt (e.g. request message, thread 10/08, 14:20
   * @alice)
   */
  source: string
}

export interface PlannedFile extends FileCandidate {
  kind: Exclude<AttachmentKind, 'unsupported'>
}

export interface SkippedFile {
  name: string
  reason: string
}

export interface SavedImage {
  path: string
  mimetype: string
  name: string
  source: string
}

export interface LoadedDocument {
  name: string
  source: string
  kind: 'text' | 'pdf'
  content: string
  /** Total characters before truncation */
  totalChars: number
}

export function classify(
  file: Pick<MessageFile, 'name' | 'mimetype' | 'filetype' | 'snippet'>
): AttachmentKind {
  const mimetype = (file.mimetype ?? '').toLowerCase()
  const filetype = (file.filetype ?? '').toLowerCase()
  if (mimetype in IMAGE_TYPES) return 'image'
  if (mimetype === 'application/pdf' || filetype === 'pdf') return 'pdf'
  if (
    file.snippet ||
    mimetype.startsWith('text/') ||
    TEXT_MIME.has(mimetype) ||
    TEXT_FILETYPES.has(filetype) ||
    TEXT_EXTENSION.test(file.name ?? '')
  ) {
    return 'text'
  }
  return 'unsupported'
}

/**
 * Picks the files to read by format, size, and count limits. Earlier candidates
 * take priority.
 */
export function planAttachments(candidates: FileCandidate[]): {
  planned: PlannedFile[]
  skipped: SkippedFile[]
} {
  const planned: PlannedFile[] = []
  const skipped: SkippedFile[] = []
  let images = 0
  let documents = 0
  for (const candidate of candidates) {
    const { file } = candidate
    const name = file.name
    if (file.unreadable) {
      skipped.push({ name, reason: file.unreadable })
      continue
    }
    const kind = classify(file)
    if (kind === 'unsupported') {
      skipped.push({
        name,
        reason: `Unsupported format (${file.filetype || file.mimetype || '?'})`,
      })
      continue
    }
    const size = file.size ?? 0
    const limit =
      kind === 'image'
        ? LIMITS.imageBytes
        : kind === 'pdf'
          ? LIMITS.pdfBytes
          : LIMITS.textBytes
    if (size > limit) {
      skipped.push({
        name,
        reason: `Size limit exceeded (${Math.round(size / 1024)}KB)`,
      })
      continue
    }
    if (
      kind === 'image' ? images >= LIMITS.images : documents >= LIMITS.documents
    ) {
      skipped.push({ name, reason: 'Count limit exceeded' })
      continue
    }
    if (kind === 'image') images += 1
    else documents += 1
    planned.push({ ...candidate, kind })
  }
  return { planned, skipped }
}

/** Converts a file name into a path-safe form. */
export function safeFileName(
  index: number,
  name: string | undefined,
  extension: string
): string {
  const base = (name ?? 'file')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 40)
  return `${index + 1}-${base || 'file'}.${extension}`
}

/** Whether the content looks like text (no NUL bytes near the start) */
export function looksLikeText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0)
}

/** Prevents the content from closing the prompt boundary tag. */
export function escapeBoundary(text: string): string {
  return text.replace(/<\/attached_file/gi, '</attached_file_')
}

export interface LoadDeps {
  dir: string
  /** The messenger's download (Messenger.download) */
  download(file: MessageFile): Promise<Download>
  /** Extracts text from a PDF. (sandbox container or host) */
  extractPdfText(pdfPath: string): Promise<string>
}

/**
 * Downloads the planned files through the messenger and checks that each is
 * what it claims to be.
 */
export async function loadAttachments(
  planned: PlannedFile[],
  deps: LoadDeps
): Promise<{
  images: SavedImage[]
  documents: LoadedDocument[]
  failed: SkippedFile[]
}> {
  await mkdir(deps.dir, { recursive: true })
  const images: SavedImage[] = []
  const documents: LoadedDocument[] = []
  const failed: SkippedFile[] = []
  let remainingChars = LIMITS.charsTotal

  for (const [index, item] of planned.entries()) {
    const name = item.file.name
    try {
      const { contentType: type, data: buffer } = await deps.download(item.file)

      if (item.kind === 'image') {
        if (!type.startsWith('image/'))
          throw new Error('Response is not an image')
        if (buffer.length > LIMITS.imageBytes)
          throw new Error('Size limit exceeded')
        const mimetype = item.file.mimetype!
        const filePath = path.join(
          deps.dir,
          safeFileName(index, item.file.name, IMAGE_TYPES[mimetype]!)
        )
        await writeFile(filePath, buffer)
        images.push({ path: filePath, mimetype, name, source: item.source })
        continue
      }

      let text: string
      if (item.kind === 'pdf') {
        if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
          throw new Error('Response is not a PDF')
        const filePath = path.join(
          deps.dir,
          safeFileName(index, item.file.name, 'pdf')
        )
        await writeFile(filePath, buffer)
        text = await deps.extractPdfText(filePath)
        if (!text.trim())
          throw new Error(
            'No text found in the PDF (it may be a scanned image)'
          )
      } else {
        if (buffer.length > LIMITS.textBytes)
          throw new Error('Size limit exceeded')
        if (!looksLikeText(buffer)) throw new Error('Not a text file')
        text = buffer.toString('utf8')
      }
      if (remainingChars <= 0) throw new Error('Total length limit exceeded')
      const limit = Math.min(LIMITS.charsPerDocument, remainingChars)
      const content = text.length > limit ? text.slice(0, limit) : text
      remainingChars -= content.length
      documents.push({
        name,
        source: item.source,
        kind: item.kind,
        content,
        totalChars: text.length,
      })
    } catch (err) {
      failed.push({ name, reason: (err as Error).message })
    }
  }
  return { images, documents, failed }
}

/**
 * Builds the prompt fragment listing the attachments passed to the model, their
 * sources, unreadable attachments, and text contents.
 */
export function attachmentSection(
  images: Pick<SavedImage, 'name' | 'source'>[],
  documents: LoadedDocument[],
  unreadable: SkippedFile[]
): string[] {
  if (images.length + documents.length + unreadable.length === 0) return []
  const lines = ['', '<attachments>']
  images.forEach((image, i) =>
    lines.push(`Image ${i + 1}: ${image.name} (${image.source})`)
  )
  documents.forEach((doc, i) => {
    const cut =
      doc.content.length < doc.totalChars
        ? `, first ${doc.content.length} of ${doc.totalChars} characters`
        : ''
    lines.push(
      `File ${i + 1}: ${doc.name} (${doc.source}, ${doc.kind === 'pdf' ? 'PDF text' : 'text'}${cut})`
    )
  })
  for (const file of unreadable)
    lines.push(`Unreadable attachment: ${file.name} - ${file.reason}`)
  lines.push('</attachments>')
  documents.forEach((doc, i) => {
    lines.push(
      '',
      `<attached_file index="${i + 1}" name="${doc.name.replace(/"/g, "'")}">`,
      escapeBoundary(doc.content),
      '</attached_file>'
    )
  })
  return lines
}
