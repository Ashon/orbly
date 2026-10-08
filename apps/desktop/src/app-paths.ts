import path from "node:path";

/**
 * 앱이 쓰는 파일 위치. 개발 실행(저장소에서 electron .)과 패키지 앱(Verda.app)이 다르다.
 * - 개발: 저장소의 빌드 결과를 쓴다. 봇은 dist/index.js (tsc), 소스가 바뀌면 다시 빌드한다.
 * - 패키지: 앱 안(Contents/Resources/app)의 묶음 파일만 쓴다. 저장소, pnpm, 빌드가 필요 없다.
 * 설정과 기록은 두 경우 모두 저장소 밖(VERDA_HOME, VERDA_DATA_DIR)에 있다.
 */
export interface AppPaths {
  packaged: boolean;
  /** 화면 (apps/web 빌드) */
  webDist: string;
  /** 봇 실행 파일 */
  botEntry: string;
  /** sandbox/compose.yaml 과 이미지 빌드 파일 */
  sandboxDir: string;
  /** 샌드박스 적용 작업 (src/tools/sandbox-job.ts 묶음) */
  jobRunner: string;
  /** 개발 실행에서만: 봇을 다시 빌드할 저장소 */
  repoRoot?: string;
}

/** distDir: 앱 main.js 가 있는 디렉터리 */
export function resolveAppPaths(distDir: string, packaged: boolean): AppPaths {
  if (packaged) {
    const appRoot = path.dirname(distDir);
    return {
      packaged,
      webDist: path.join(appRoot, "web"),
      botEntry: path.join(appRoot, "bot/index.mjs"),
      sandboxDir: path.join(appRoot, "sandbox"),
      jobRunner: path.join(appRoot, "tools/sandbox-job.mjs"),
    };
  }
  const repoRoot = path.resolve(distDir, "../../..");
  return {
    packaged,
    webDist: path.join(repoRoot, "apps/web/dist"),
    botEntry: path.join(repoRoot, "dist/index.js"),
    sandboxDir: path.join(repoRoot, "sandbox"),
    jobRunner: path.join(repoRoot, "build/tools/sandbox-job.mjs"),
    repoRoot,
  };
}
