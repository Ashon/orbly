import { describe, expect, it } from "vitest";
import {
  ConcurrencyLimiter,
  isAllowedUser,
  stripBotMention,
  systemPrompt,
} from "../src/mention/responder.js";

describe("stripBotMention", () => {
  it("removes only the bot mention and keeps other mentions", () => {
    expect(
      stripBotMention("<@UBOT> what is the review status of <@U1>'s PR", "UBOT")
    ).toBe("what is the review status of <@U1>'s PR");
    expect(stripBotMention("<@UBOT|agent>  ", "UBOT")).toBe("");
  });
});

describe("isAllowedUser", () => {
  it("allows everyone when the list is empty, otherwise only listed users", () => {
    expect(isAllowedUser("U1", [])).toBe(true);
    expect(isAllowedUser("U1", ["U1"])).toBe(true);
    expect(isAllowedUser("U2", ["U1"])).toBe(false);
  });
});

describe("systemPrompt", () => {
  it("adds file lookup instructions only when there is a reference directory", () => {
    expect(systemPrompt(false)).not.toContain("working directory");
    expect(systemPrompt(true)).toContain("working directory");
    expect(systemPrompt(false)).toContain(
      "<slack_thread> is conversation context for reference"
    );
    expect(systemPrompt(false)).toContain("Reply in the language of the conversation.");
  });
});

describe("ConcurrencyLimiter", () => {
  it("enforces the concurrency and queue limits", async () => {
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

    expect(limiter.tryRun(task)).toBe(true); // runs
    expect(limiter.tryRun(task)).toBe(true); // queued
    expect(limiter.tryRun(task)).toBe(false); // full
    expect(releases).toHaveLength(1);

    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1); // the queued task starts
    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(maxRunning).toBe(1);
  });
});
