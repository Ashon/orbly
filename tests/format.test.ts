import { describe, expect, it } from "vitest";
import {
  escapeSlackText,
  extractUserIds,
  renderSlackText,
  toSlackMrkdwn,
} from "../src/messengers/slack/format.js";
import { chunkText, formatTime } from "../src/messengers/text.js";

describe("chunkText", () => {
  it("splits on line boundaries and force-splits lines that are too long", () => {
    const text = ["a".repeat(6), "b".repeat(6), "c".repeat(25)].join("\n");
    expect(chunkText(text, 10)).toEqual([
      "aaaaaa",
      "bbbbbb",
      "cccccccccc",
      "cccccccccc",
      "ccccc",
    ]);
  });

  it("returns one chunk even for empty text", () => {
    expect(chunkText("", 10)).toEqual([""]);
  });
});

describe("toSlackMrkdwn", () => {
  it("converts Markdown emphasis, headings, links, and bullets", () => {
    const input = "## Summary\n* **Deploy** done\n[PR](https://example.com/pr/1)";
    expect(toSlackMrkdwn(input)).toBe(
      "*Summary*\n- *Deploy* done\n<https://example.com/pr/1|PR>"
    );
  });

  it("leaves code blocks untouched", () => {
    const input = "```\n**raw**\n```";
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it("shows mentions and alerts in model answers as literal text and keeps web links and quotes", () => {
    const input = [
      "<!channel> <!here|here> <@U123> <#C1|ops> <!subteam^S1>",
      "a & b, List<String>",
      "> quote",
      "<https://x.io/a?b=1&c=2|docs> <https://x.io>",
      "[PR](https://x.io/pr?a=1&b=2)",
      "```",
      "<!channel> if (a < b && c > d)",
      "```",
    ].join("\n");
    expect(toSlackMrkdwn(input)).toBe(
      [
        "&lt;!channel> &lt;!here|here> &lt;@U123> &lt;#C1|ops> &lt;!subteam^S1>",
        "a &amp; b, List&lt;String>",
        "> quote",
        "<https://x.io/a?b=1&amp;c=2|docs> <https://x.io>",
        "<https://x.io/pr?a=1&amp;b=2|PR>",
        "```",
        "&lt;!channel> if (a &lt; b &amp;&amp; c > d)",
        "```",
      ].join("\n")
    );
  });

  it("neutralizes control markup mixed into link URLs or names", () => {
    expect(toSlackMrkdwn("[x](https://a.io/><!channel>)")).not.toContain("<!channel>");
    expect(toSlackMrkdwn("<https://a.io|<!channel>>")).not.toContain("<!channel>");
    expect(escapeSlackText("<@U1> & <!here>")).toBe("&lt;@U1> &amp; &lt;!here>");
  });
});

describe("renderSlackText", () => {
  it("converts mentions, channels, links, and special mentions to plain text", () => {
    const text = "<@U1> <#C1|dev> <!here> <https://x.io|docs> &lt;b&gt;";
    expect(extractUserIds(text)).toEqual(["U1"]);
    expect(renderSlackText(text, new Map([["U1", "alice"]]))).toBe(
      "@alice #dev @here docs (https://x.io) <b>"
    );
  });
});

describe("formatTime", () => {
  it("formats month, day, and 24-hour time in the given time zone", () => {
    expect(formatTime(Date.UTC(2026, 9, 8, 5, 20), "Asia/Seoul")).toBe("10/08, 14:20");
    expect(formatTime(Date.UTC(2026, 9, 7, 15, 5), "Asia/Seoul")).toBe("10/08, 00:05");
  });
});
