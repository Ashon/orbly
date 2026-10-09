import { describe, expect, it } from "vitest";
import {
  chunkText,
  escapeSlackText,
  extractUserIds,
  renderSlackText,
  toSlackMrkdwn,
} from "../src/slack/format.js";

describe("chunkText", () => {
  it("줄 경계로 나누고 너무 긴 줄은 강제로 자른다", () => {
    const text = ["a".repeat(6), "b".repeat(6), "c".repeat(25)].join("\n");
    expect(chunkText(text, 10)).toEqual([
      "aaaaaa",
      "bbbbbb",
      "cccccccccc",
      "cccccccccc",
      "ccccc",
    ]);
  });

  it("빈 텍스트도 조각 하나를 돌려준다", () => {
    expect(chunkText("")).toEqual([""]);
  });
});

describe("toSlackMrkdwn", () => {
  it("Markdown 강조, 제목, 링크, 불릿을 변환한다", () => {
    const input = "## 요약\n* **배포** 완료\n[PR](https://example.com/pr/1)";
    expect(toSlackMrkdwn(input)).toBe(
      "*요약*\n- *배포* 완료\n<https://example.com/pr/1|PR>"
    );
  });

  it("코드 블록 안은 건드리지 않는다", () => {
    const input = "```\n**raw**\n```";
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it("모델 답의 멘션, 알림 표기는 글자 그대로 보이게 하고 웹 링크와 인용은 남긴다", () => {
    const input = [
      "<!channel> <!here|here> <@U123> <#C1|ops> <!subteam^S1>",
      "a & b, List<String>",
      "> 인용",
      "<https://x.io/a?b=1&c=2|문서> <https://x.io>",
      "[PR](https://x.io/pr?a=1&b=2)",
      "```",
      "<!channel> if (a < b && c > d)",
      "```",
    ].join("\n");
    expect(toSlackMrkdwn(input)).toBe(
      [
        "&lt;!channel> &lt;!here|here> &lt;@U123> &lt;#C1|ops> &lt;!subteam^S1>",
        "a &amp; b, List&lt;String>",
        "> 인용",
        "<https://x.io/a?b=1&amp;c=2|문서> <https://x.io>",
        "<https://x.io/pr?a=1&amp;b=2|PR>",
        "```",
        "&lt;!channel> if (a &lt; b &amp;&amp; c > d)",
        "```",
      ].join("\n")
    );
  });

  it("링크 주소나 이름에 섞인 제어 표기도 무력화한다", () => {
    expect(toSlackMrkdwn("[x](https://a.io/><!channel>)")).not.toContain("<!channel>");
    expect(toSlackMrkdwn("<https://a.io|<!channel>>")).not.toContain("<!channel>");
    expect(escapeSlackText("<@U1> & <!here>")).toBe("&lt;@U1> &amp; &lt;!here>");
  });
});

describe("renderSlackText", () => {
  it("멘션, 채널, 링크, 특수 멘션을 평문으로 바꾼다", () => {
    const text = "<@U1> <#C1|dev> <!here> <https://x.io|문서> &lt;b&gt;";
    expect(extractUserIds(text)).toEqual(["U1"]);
    expect(renderSlackText(text, new Map([["U1", "alice"]]))).toBe(
      "@alice #dev @here 문서 (https://x.io) <b>"
    );
  });
});
