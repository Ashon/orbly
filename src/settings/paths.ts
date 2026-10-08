import { homedir } from "node:os";
import path from "node:path";

/**
 * 저장소 밖의 Verda 설정 위치. 설정 파일(.env)과 ops-broker 실행 파일(호스트 목록, kubeconfig)을 둔다.
 * 대상 환경의 값이 저장소에 남지 않도록 저장소 안에는 두지 않는다.
 * 위치는 VERDA_HOME 환경 변수로 바꾼다. (기본 ~/.verda, package.json 스크립트와 sandbox/compose.yaml 도 같은 규칙)
 */
export function verdaHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const value = env.VERDA_HOME?.trim() || "~/.verda";
  return value === "~" || value.startsWith("~/")
    ? path.join(home, value.slice(1))
    : path.resolve(value);
}

/** 봇, 데스크톱 앱, 준비 명령, compose 가 함께 쓰는 설정 파일 */
export function envFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return path.join(verdaHome(env, home), ".env");
}

/** broker 가 마운트하는 생성 파일(hosts.json, kubeconfig)과 비운 마운트의 빈 자리(unset/) */
export function brokerRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return path.join(verdaHome(env, home), "ops-broker");
}
