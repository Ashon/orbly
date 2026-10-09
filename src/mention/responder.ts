import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from '../config.js'
import type { HistoryStore, RunHandle } from '../history/recorder.js'
import type { Logger } from '../logger.js'
import {
  mentionKey,
  type ContextMessage,
  type Mention,
  type Messenger,
  type MessengerId,
  type Request,
  type Upload,
} from '../messengers/types.js'
import { formatTime, truncate } from '../messengers/text.js'
import type { Reasoner } from '../reasoner/index.js'
import {
  composeAnswer,
  extractDiagrams,
  type DiagramRenderer,
} from '../render/diagrams.js'
import {
  attachmentSection,
  loadAttachments,
  planAttachments,
  type FileCandidate,
} from './attachments.js'
import { collectGeneratedImages } from './generated.js'
import { resumeDecision, type InflightStore } from './inflight.js'
import { ConcurrencyLimiter } from './limiter.js'
import { systemPrompt, userPrompt } from './prompt.js'
import { recordAttachments, recordOutputs } from './run-record.js'

/** Run queue limit. Beyond it, the bot replies that it is busy. */
const MAX_QUEUE = 10
const CONTEXT_MESSAGES = 30
const CONTEXT_MESSAGE_CHARS = 1_500

export interface MentionResponderDeps {
  config: Config
  /**
   * The connected messengers; each mention is answered through the one it came
   * from
   */
  messengers: readonly Messenger[]
  reasoner: Reasoner
  log: Logger
  /** Extracts PDF text (the executor runs it in the sandbox container) */
  extractPdfText(pdfPath: string): Promise<string>
  /**
   * When set, renders diagram/chart blocks in the answer and posts them to the
   * thread.
   */
  renderer?: DiagramRenderer
  /** Record of in-progress requests. They are resumed after a restart. */
  inflight?: InflightStore
  /** Run history. Viewed in the desktop app. */
  history?: HistoryStore
  /**
   * Called whenever the active/handled request counts change. (bot status file)
   */
  onActivity?: (requests: {
    active: number
    handled: number
    lastAt?: string
  }) => void
}

/**
 * At startup, temporary attachment directories older than this are treated as
 * leftovers of interrupted requests and removed.
 */
const STALE_ATTACHMENTS_MS = 60 * 60_000

export function isAllowedUser(
  userId: string,
  allowedUserIds: readonly string[]
): boolean {
  return allowedUserIds.length === 0 || allowedUserIds.includes(userId)
}

interface Resume {
  placeholder: string
  attempts: number
  startedAt: number
  runId?: string
}

interface Figure {
  figure: number
  png: Buffer
  raw: string
}

/**
 * Answers a mention from any messenger: collects the conversation, passes it to
 * the local CLI (claude or codex), and posts the answer to the same thread as
 * the bot. Everything messenger-specific goes through Messenger.
 */
export class MentionResponder {
  private readonly limiter: ConcurrencyLimiter
  private readonly seen = new Set<string>()
  private readonly messengers: Map<MessengerId, Messenger>
  private readonly requests: {
    active: number
    handled: number
    lastAt?: string
  } = {
    active: 0,
    handled: 0,
  }

  /**
   * Where attachment images are downloaded temporarily. Uses the data folder
   * under home (PACENOTE_DATA_DIR) so Docker can mount it.
   */
  private readonly attachmentsRoot: string

  constructor(private readonly deps: MentionResponderDeps) {
    this.attachmentsRoot = path.join(deps.config.dataDir, 'attachments')
    this.limiter = new ConcurrencyLimiter(
      deps.config.mention.concurrency,
      MAX_QUEUE
    )
    this.messengers = new Map(
      deps.messengers.map((messenger) => [messenger.id, messenger])
    )
  }

  async handle(mention: Mention): Promise<void> {
    const { log } = this.deps
    const messenger = this.messengers.get(mention.messenger)
    if (!messenger) return

    // Handles redelivered events only once.
    const key = mentionKey(mention)
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.values().next().value!)

    const say = (markdown: string) => messenger.render(markdown)[0] ?? ''
    if (!isAllowedUser(mention.userId, messenger.allowedUsers)) {
      log.info(
        `Ignoring mention from a user not on the allowlist: ${mention.userId} in ${mention.conversation}`
      )
      await messenger.notice(
        mention,
        say('I only answer specific people here.')
      )
      return
    }
    const venue = await messenger.venue(mention)
    if (!venue.answerable) {
      await messenger.notice(
        mention,
        say(venue.refusal ?? "I don't answer here.")
      )
      return
    }

    const accepted = this.limiter.tryRun(() =>
      this.respond(messenger, mention, venue.label)
    )
    if (!accepted) {
      await messenger.post(
        mention,
        say(
          'I have too many requests right now. Please mention me again in a moment.'
        )
      )
    }
  }

  private async respond(
    messenger: Messenger,
    mention: Mention,
    label: string,
    resume?: Resume
  ) {
    const { config, reasoner, log, inflight } = this.deps
    const where = `${reasoner.backend}@${reasoner.sandbox}`
    const say = (markdown: string) => messenger.render(markdown)[0] ?? ''
    let placeholder: string
    if (resume) {
      placeholder = resume.placeholder
      await messenger
        .update(
          mention,
          placeholder,
          say(`I restarted, so I'm picking this up again... (\`${where}\`)`)
        )
        .catch(() => undefined)
    } else {
      placeholder = await messenger.post(
        mention,
        say(`Working on it... (\`${where}\`)`)
      )
    }
    const key = mentionKey(mention)
    this.requests.active += 1
    this.requests.lastAt = new Date().toISOString()
    this.deps.onActivity?.({ ...this.requests })
    const attachmentsDir = path.join(this.attachmentsRoot, randomUUID())
    let run: RunHandle | undefined

    try {
      const request = await messenger.request(mention)
      run = this.openRun(
        messenger,
        mention,
        label,
        request,
        placeholder,
        resume?.runId
      )
      inflight?.upsert({
        key,
        mention,
        label,
        placeholder,
        runId: run?.id,
        attempts: (resume?.attempts ?? 0) + 1,
        startedAt: resume?.startedAt ?? Date.now(),
      })
      const context = (
        await messenger.context(mention, [mention.message, placeholder])
      ).slice(-CONTEXT_MESSAGES)
      run?.patch({ context: { messages: context.length } })
      const time = (at: number) => formatTime(at, config.timezone)
      const render = (line: ContextMessage) => {
        const files = line.files.length
          ? ` [attachments: ${line.files.map((f) => f.name).join(', ')}]`
          : ''
        return `${time(line.at)} ${line.author}: ${truncate(line.text, CONTEXT_MESSAGE_CHARS)}${files}`
      }

      // Passes the request message attachments first, then recent attachments
      // in the thread.
      const candidates: FileCandidate[] = [
        ...mention.files.map((file) => ({ file, source: 'request message' })),
        ...[...context].reverse().flatMap((line) =>
          line.files.map((file) => ({
            file,
            source: `thread ${time(line.at)} ${line.author}`,
          }))
        ),
      ]
      const files = await messenger.resolveFiles(candidates.map((c) => c.file))
      const resolved = candidates.map((candidate, i) => ({
        ...candidate,
        file: files[i]!,
      }))
      const { planned, skipped } = planAttachments(resolved)
      const { images, documents, failed } = await loadAttachments(planned, {
        dir: attachmentsDir,
        download: (file) => messenger.download(file),
        extractPdfText: this.deps.extractPdfText,
      })
      const unreadable = [...skipped, ...failed]
      if (run) await recordAttachments(run, images, documents, skipped, failed)
      if (resolved.length > 0) {
        log.info(
          `${resolved.length} ${resolved.length === 1 ? 'attachment' : 'attachments'}: images ${images.length}, files ${documents.length}, unreadable ${unreadable.length}` +
            (unreadable.length
              ? ` (${unreadable.map((f) => `${f.name}: ${f.reason}`).join('; ')})`
              : '')
        )
      }

      const prompt = userPrompt({
        venue: label,
        context: context.map(render),
        author: request.author,
        request: request.text,
        attachments: attachmentSection(images, documents, unreadable),
      })
      const readOnlyDir = reasoner.canReadFiles
        ? config.mention.workspace
        : undefined
      // Images generated by codex land here. Created in advance so Docker does
      // not create it owned by root.
      const outputDir = path.join(attachmentsDir, 'generated')
      await mkdir(outputDir, { recursive: true })
      const started = Date.now()
      const system = systemPrompt(messenger.profile, {
        canReadWorkspace: readOnlyDir !== undefined,
        opsTools: reasoner.mcpServerNames.includes('ops'),
        diagrams: this.deps.renderer !== undefined,
        imageGeneration: reasoner.backend === 'codex',
      })
      run?.setPrompt(system, prompt)
      const answer = await reasoner.complete({
        system,
        prompt,
        readOnlyDir,
        images: images.map((image) => ({
          path: image.path,
          mimetype: image.mimetype,
        })),
        outputDir,
        onEvent: run ? (step) => run?.event(step) : undefined,
      })
      run?.patch({ answer })
      log.info(`Answered mention ${key} (${where}, ${Date.now() - started}ms)`)

      const { text, figures } = await this.renderDiagrams(
        answer,
        attachmentsDir
      )
      const [first = '', ...rest] = messenger.render(text)
      await messenger.update(mention, placeholder, first)
      for (const chunk of rest) await messenger.post(mention, chunk)
      const generated = await this.shrinkImages(
        await collectGeneratedImages(outputDir),
        attachmentsDir
      )
      if (run) await recordOutputs(run, generated, figures, log)
      if (!(await this.postImages(messenger, mention, generated, figures))) {
        run?.event({
          kind: 'error',
          at: new Date().toISOString(),
          message: 'Image upload failed (check files:write)',
        })
      }
      run?.finish('succeeded')
    } catch (err) {
      log.error(`Failed to answer mention ${key}`, err)
      run?.finish('failed', { error: (err as Error).message })
      // The conversation may be public, so internal error details go only to
      // the log.
      const reason = /timed out/.test((err as Error).message)
        ? 'The request timed out.'
        : 'An error occurred while processing the request.'
      await messenger
        .update(
          mention,
          placeholder,
          say(`I couldn't produce an answer. ${reason}`)
        )
        .catch(() => undefined)
    } finally {
      inflight?.remove(key)
      await rm(attachmentsDir, { recursive: true, force: true })
      this.requests.active -= 1
      this.requests.handled += 1
      this.deps.onActivity?.({ ...this.requests })
    }
  }

  /**
   * Cleans up interrupted requests at startup. Each is resumed once in the same
   * placeholder message, and requests that were already retried or are too old
   * are reported as failed.
   */
  async resumePending(): Promise<void> {
    const { inflight, log, history } = this.deps
    await this.cleanupStaleAttachments()
    const entries = inflight?.list() ?? []
    // Keeps the runs of requests to resume, and marks the other runs still left
    // as running as interrupted.
    const resuming = new Set(
      entries.flatMap((entry) =>
        entry.runId &&
        this.messengers.has(entry.mention.messenger) &&
        resumeDecision(entry) === 'resume'
          ? [entry.runId]
          : []
      )
    )
    const interrupted = history?.interruptStale(resuming) ?? 0
    if (interrupted > 0)
      log.info(
        `Marked ${interrupted} ${interrupted === 1 ? 'run' : 'runs'} as interrupted.`
      )
    if (!inflight) return
    for (const entry of entries) {
      this.seen.add(entry.key)
      const messenger = this.messengers.get(entry.mention.messenger)
      if (!messenger) {
        // Asked in a messenger the bot no longer connects to: nothing to answer
        // through.
        inflight.remove(entry.key)
        log.warn(
          `Dropping interrupted request ${entry.key}: ${entry.mention.messenger} is not connected`
        )
        continue
      }
      if (resumeDecision(entry) === 'give_up') {
        inflight.remove(entry.key)
        log.warn(
          `Giving up on interrupted request ${entry.key} (${entry.attempts} ${entry.attempts === 1 ? 'attempt' : 'attempts'})`
        )
        await messenger
          .update(
            entry.mention,
            entry.placeholder,
            messenger.render(
              "I couldn't finish this: I restarted and the request was cut off. Please mention me again."
            )[0] ?? ''
          )
          .catch(() => undefined)
        continue
      }
      log.info(
        `Resuming interrupted request ${entry.key} (attempt ${entry.attempts + 1})`
      )
      const accepted = this.limiter.tryRun(() =>
        this.respond(messenger, entry.mention, entry.label, {
          placeholder: entry.placeholder,
          attempts: entry.attempts,
          startedAt: entry.startedAt,
          runId: entry.runId,
        })
      )
      if (!accepted) {
        inflight.remove(entry.key)
        if (entry.runId) {
          history?.reopen(entry.runId)?.finish('interrupted', {
            error: 'Could not resume because the queue was full',
          })
        }
      }
    }
  }

  /**
   * Waits for active requests to finish before shutdown. Remaining requests are
   * resumed at the next start.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.limiter.busy && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return !this.limiter.busy
  }

  /**
   * Starts a run, or reopens the existing run when resuming after a restart.
   */
  private openRun(
    messenger: Messenger,
    mention: Mention,
    label: string,
    request: Request,
    placeholder: string,
    runId?: string
  ): RunHandle | undefined {
    const { history, reasoner, config, log } = this.deps
    if (!history) return undefined
    try {
      const reopened = runId ? history.reopen(runId) : undefined
      if (reopened) {
        reopened.resume()
        return reopened
      }
      return history.start({
        origin: {
          messenger: mention.messenger,
          conversation: mention.conversation,
          conversationLabel: label,
          thread: mention.thread,
          message: mention.message,
          placeholder,
          permalink: messenger.permalink(mention, placeholder),
          userId: mention.userId,
          userName: request.userName,
        },
        request: request.text,
        backend: {
          reasoner: reasoner.backend,
          sandbox: reasoner.sandbox,
          model: config.reasoner.model,
        },
      })
    } catch (err) {
      log.warn(`Failed to start a run: ${(err as Error).message}`)
      return undefined
    }
  }

  private async cleanupStaleAttachments(): Promise<void> {
    const now = Date.now()
    for (const name of await readdir(this.attachmentsRoot).catch(
      () => [] as string[]
    )) {
      const dir = path.join(this.attachmentsRoot, name)
      const info = await stat(dir).catch(() => undefined)
      if (info?.isDirectory() && now - info.mtimeMs > STALE_ATTACHMENTS_MS) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }

  /**
   * Renders the diagram blocks in the answer. Failed blocks keep their source,
   * and without a renderer the answer is unchanged.
   */
  private async renderDiagrams(
    answer: string,
    workDir: string
  ): Promise<{ text: string; figures: Figure[] }> {
    const { renderer, log } = this.deps
    const blocks = renderer ? extractDiagrams(answer) : []
    if (!renderer || blocks.length === 0) return { text: answer, figures: [] }

    const dir = path.join(workDir, 'renders')
    const figures: Figure[] = []
    const results: { block: (typeof blocks)[number]; figure?: number }[] = []
    for (const [i, block] of blocks.entries()) {
      try {
        const png = await renderer.render(block, dir, `figure-${i + 1}`)
        const figure = figures.length + 1
        figures.push({ figure, png, raw: block.raw })
        results.push({ block, figure })
      } catch (err) {
        log.warn(
          `Failed to render diagram ${i + 1} (${block.format}): ${(err as Error).message.slice(0, 300)}`
        )
        results.push({ block })
      }
    }
    return { text: composeAnswer(answer, results), figures }
  }

  /**
   * Shrinks generated images to the configured size (long edge). Uses the
   * original without a renderer or on failure.
   */
  private async shrinkImages(
    images: Buffer[],
    workDir: string
  ): Promise<Buffer[]> {
    const { renderer, config, log } = this.deps
    const maxPx = config.render.generatedMaxPx
    if (!renderer || maxPx === 0) return images
    const dir = path.join(workDir, 'resized')
    return Promise.all(
      images.map((image, i) =>
        renderer
          .resize(image, dir, `image-${i + 1}`, maxPx)
          .catch((err: unknown) => {
            log.warn(
              `Failed to resize generated image ${i + 1}, posting the original: ${(err as Error).message}`
            )
            return image
          })
      )
    )
  }

  /**
   * Posts generated images and rendered diagrams to the thread. When the upload
   * fails, posts the diagram sources instead and returns false.
   */
  private async postImages(
    messenger: Messenger,
    mention: Mention,
    generated: Buffer[],
    figures: Figure[]
  ): Promise<boolean> {
    const uploads: (Upload & { raw?: string })[] = [
      ...generated.map((data, i) => ({
        data,
        filename: `image-${i + 1}.png`,
        title: `Generated image ${i + 1}`,
      })),
      ...figures.map(({ figure, png, raw }) => ({
        data: png,
        filename: `figure-${figure}.png`,
        title: `Figure ${figure}`,
        raw,
      })),
    ]
    if (uploads.length === 0) return true
    try {
      await messenger.upload(mention, uploads)
      return true
    } catch (err) {
      this.deps.log.error('Image upload failed (check files:write)', err)
      const sources = uploads
        .filter((upload) => upload.raw)
        .map(
          (upload) => `${upload.title} source:\n\`\`\`\n${upload.raw}\n\`\`\``
        )
        .join('\n\n')
      for (const chunk of messenger.render(
        `I couldn't upload the images.${sources ? `\n${sources}` : ''}`
      )) {
        await messenger.post(mention, chunk).catch(() => undefined)
      }
      return false
    }
  }
}
