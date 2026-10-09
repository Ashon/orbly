/**
 * Run history storage layout. Shared by the bot (writes) and the desktop app
 * (reads).
 *   <root>/runs/<YYYY-MM-DD>/<run id>/run.json
 *   <root>/runs/<YYYY-MM-DD>/<run id>/artifacts/<file>
 * The run id holds the start time (local time), so the id alone locates the day
 * directory.
 */
export const RUNS_DIR = 'runs'
export const RUN_FILE = 'run.json'
export const ARTIFACTS_DIR = 'artifacts'

const RUN_ID = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4,}$/
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const pad = (n: number) => String(n).padStart(2, '0')

export function runIdFor(date: Date, suffix: string): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}-${suffix}`
}

/** Day directory name for a run id. undefined if the format is wrong */
export function dayOf(id: string): string | undefined {
  const match = RUN_ID.exec(id)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

export function dayDirFor(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const isDayDir = (name: string) => DAY_DIR.test(name)

export const isSafeArtifactName = (name: string) =>
  ARTIFACT_NAME.test(name) && !name.includes('..')
