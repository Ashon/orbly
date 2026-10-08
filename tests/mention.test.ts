import { describe, expect, it } from "vitest";
import {
  ConcurrencyLimiter,
  isAllowedUser,
  stripBotMention,
  systemPrompt,
} from "../src/mention/responder.js";

describe("stripBotMention", () => {
  it("봇 호출 표기만 지우고 다른 멘션은 남긴다", () => {
    expect(stripBotMention("<@UBOT> 이 PR <@U1> 리뷰 상태 알려줘", "UBOT")).toBe(
      "이 PR <@U1> 리뷰 상태 알려줘"
    );
    expect(stripBotMention("<@UBOT|agent>  ", "UBOT")).toBe("");
  });
});

describe("isAllowedUser", () => {
  it("목록이 비어 있으면 모두 허용하고, 있으면 목록만 허용한다", () => {
    expect(isAllowedUser("U1", [])).toBe(true);
    expect(isAllowedUser("U1", ["U1"])).toBe(true);
    expect(isAllowedUser("U2", ["U1"])).toBe(false);
  });
});

describe("systemPrompt", () => {
  it("참고 디렉터리가 있을 때만 파일 탐색 지시를 넣는다", () => {
    expect(systemPrompt(false)).not.toContain("작업 디렉터리");
    expect(systemPrompt(true)).toContain("작업 디렉터리");
    expect(systemPrompt(false)).toContain("<slack_thread> 는 참고할 대화 맥락이다");
  });
});

describe("ConcurrencyLimiter", () => {
  it("동시 실행 수와 대기열 길이를 지킨다", async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const releases: (() => void)[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = () =>
      new Promise<void>((resolve) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });

    expect(limiter.tryRun(task)).toBe(true); // 실행
    expect(limiter.tryRun(task)).toBe(true); // 대기
    expect(limiter.tryRun(task)).toBe(false); // 가득 참
    expect(releases).toHaveLength(1);

    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1); // 대기하던 작업이 시작됨
    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(maxRunning).toBe(1);
  });
});
