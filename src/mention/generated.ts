import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const GENERATED_IMAGE = /\.(png|jpe?g|webp|gif)$/i
const MAX_GENERATED_IMAGES = 4
const MAX_GENERATED_BYTES = 20 * 1024 * 1024

/**
 * Reads the images codex generated in outputDir in creation order. (up to one
 * subdirectory level)
 */
export async function collectGeneratedImages(
  outputDir: string
): Promise<Buffer[]> {
  const files: { file: string; mtime: number }[] = []
  const visit = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      () => []
    )) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 1) await visit(file, depth + 1)
      if (!entry.isFile() || !GENERATED_IMAGE.test(entry.name)) continue
      const info = await stat(file)
      if (info.size > 0 && info.size <= MAX_GENERATED_BYTES)
        files.push({ file, mtime: info.mtimeMs })
    }
  }
  await visit(outputDir, 0)
  files.sort((a, b) => a.mtime - b.mtime)
  return Promise.all(
    files.slice(0, MAX_GENERATED_IMAGES).map(({ file }) => readFile(file))
  )
}
