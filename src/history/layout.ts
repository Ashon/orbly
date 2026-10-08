/**
 * 실행 기록 저장 구조. 봇(기록)과 데스크톱 앱(조회)이 함께 쓴다.
 *   <root>/runs/<YYYY-MM-DD>/<run id>/run.json
 *   <root>/runs/<YYYY-MM-DD>/<run id>/artifacts/<file>
 * run id 는 시작 시각(로컬 시간)을 담아서 id 만으로 날짜 디렉터리를 찾을 수 있다.
 */
export const RUNS_DIR = "runs";
export const RUN_FILE = "run.json";
export const ARTIFACTS_DIR = "artifacts";

const RUN_ID = /^(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4,}$/;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function runIdFor(date: Date, suffix: string): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${suffix}`;
}

/** run id 의 날짜 디렉터리 이름. 형식이 틀리면 undefined */
export function dayOf(id: string): string | undefined {
  const match = RUN_ID.exec(id);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export function dayDirFor(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const isDayDir = (name: string) => DAY_DIR.test(name);

export const isSafeArtifactName = (name: string) =>
  ARTIFACT_NAME.test(name) && !name.includes("..");
