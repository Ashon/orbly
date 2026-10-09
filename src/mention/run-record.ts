import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunHandle } from '../history/recorder.js'
import type { RunAttachment } from '../history/types.js'
import type { Logger } from '../logger.js'
import type { LoadedDocument, SavedImage, SkippedFile } from './attachments.js'

/**
 * Records the attachments passed to the model and saves copies of the images as
 * artifacts.
 */
export async function recordAttachments(
  run: RunHandle,
  images: Pick<SavedImage, 'path' | 'name' | 'source'>[],
  documents: Pick<LoadedDocument, 'name' | 'source' | 'kind'>[],
  skipped: SkippedFile[],
  failed: SkippedFile[]
): Promise<void> {
  const attachments: RunAttachment[] = []
  for (const [i, image] of images.entries()) {
    const file = await readFile(image.path)
      .then((data) =>
        run.saveArtifact(`input-${i + 1}${path.extname(image.path)}`, data)
      )
      .catch(() => undefined)
    attachments.push({
      name: image.name,
      source: image.source,
      kind: 'image',
      status: 'read',
      file,
    })
  }
  for (const doc of documents) {
    attachments.push({
      name: doc.name,
      source: doc.source,
      kind: doc.kind,
      status: 'read',
    })
  }
  for (const [list, status] of [
    [skipped, 'skipped'],
    [failed, 'failed'],
  ] as const) {
    for (const item of list) {
      attachments.push({
        name: item.name,
        source: '',
        kind: 'other',
        status,
        reason: item.reason,
      })
    }
  }
  run.patch({ attachments })
}

/** Records the posted generated images and diagrams as outputs. */
export async function recordOutputs(
  run: RunHandle,
  generated: Buffer[],
  figures: { figure: number; png: Buffer; raw: string }[],
  log: Logger
): Promise<void> {
  const outputs = [...run.record.outputs]
  try {
    for (const [i, png] of generated.entries()) {
      const file = await run.saveArtifact(`image-${i + 1}.png`, png)
      outputs.push({
        kind: 'generated',
        file,
        title: `Generated image ${i + 1}`,
      })
    }
    for (const { figure, png, raw } of figures) {
      const file = await run.saveArtifact(`figure-${figure}.png`, png)
      outputs.push({
        kind: 'diagram',
        file,
        title: `Figure ${figure}`,
        source: raw,
      })
    }
  } catch (err) {
    log.warn(
      `Failed to record outputs for ${run.id}: ${(err as Error).message}`
    )
  }
  run.patch({ outputs })
}
