import { describe, expect, it } from "vitest";
import { formatDuration, previewArgs } from "../apps/web/src/lib/format.js";
import { slackToMarkdown } from "../apps/web/src/lib/slack.js";

describe("slackToMarkdown", () => {
  it("Slack 굵게, 취소선, 링크를 Markdown 으로 바꾸고 코드는 그대로 둔다", () => {
    expect(slackToMarkdown("*web-01 점검 결과*")).toBe("**web-01 점검 결과**");
    expect(slackToMarkdown("- 사용률 *90%* (180G)")).toBe("- 사용률 **90%** (180G)");
    expect(slackToMarkdown("* 목록 항목")).toBe("* 목록 항목");
    expect(slackToMarkdown("이미 **굵게** 는 그대로")).toBe("이미 **굵게** 는 그대로");
    expect(slackToMarkdown("`a*b*c` 와 *x*")).toBe("`a*b*c` 와 **x**");
    expect(slackToMarkdown("2*3*4 계산")).toBe("2*3*4 계산");
    expect(slackToMarkdown("~취소~")).toBe("~~취소~~");
    expect(slackToMarkdown("<https://github.com/x/y/pull/1|PR #1>")).toBe(
      "[PR #1](https://github.com/x/y/pull/1)"
    );
    expect(slackToMarkdown("```\n*keep*\n```\n*bold*")).toBe(
      "```\n*keep*\n```\n**bold**"
    );
    expect(
      slackToMarkdown("등록했습니다.\n\n• 차트 첨부\n  ◦ 범위 표시\n• 실패 시 텍스트")
    ).toBe("등록했습니다.\n\n- 차트 첨부\n  - 범위 표시\n- 실패 시 텍스트");
    expect(slackToMarkdown("```\n• keep\n```")).toBe("```\n• keep\n```");
  });
});

describe("화면 표시 형식", () => {
  it("소요 시간과 도구 인자 미리보기", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_340)).toBe("12.3초");
    expect(formatDuration(125_000)).toBe("2분 5초");
    expect(formatDuration(899_700)).toBe("15분");
    expect(formatDuration(7_217_000)).toBe("2시간");
    expect(formatDuration(7_500_000)).toBe("2시간 5분");
    expect(formatDuration(undefined)).toBe("-");
    expect(previewArgs({ host: "web-01", check: "uptime" })).toBe(
      "host=web-01 check=uptime"
    );
    expect(previewArgs({ q: "x".repeat(200) }, 20)).toHaveLength(20);
  });
});
