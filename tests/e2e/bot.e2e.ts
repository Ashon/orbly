import { afterEach, describe, expect, it } from "vitest";
import { eventually, sleep, startBot } from "./support/processes.js";
import { World } from "./support/world.js";

/** The bot on a Slack app of its own (Socket Mode), the way a member uses Orbly alone */

let world: World | undefined;
afterEach(async () => {
  await world?.stop();
  world = undefined;
});

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1a3c5a40000000049454e44ae426082",
  "hex"
);

describe("bot on its own Slack app", () => {
  it("answers a mention in a thread, with the thread as context", async () => {
    world = await World.create([
      {
        match: "web-01",
        answer: "**Healthy**. See [the runbook](https://runbook.example.com).",
      },
    ]);
    const { slack, ops, alice, bob } = world;
    const root = slack.post(ops.id, {
      user: bob.id,
      text: `web-01 is slow, <@${alice.id}>?`,
    });
    await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> check web-01`,
      thread_ts: root,
    });
    const [reply] = await world.answered(ops.id, root);

    // The placeholder is edited into the answer, in Slack mrkdwn.
    expect(reply!.edits).toEqual(["Working on an answer... (`claude@host`)"]);
    expect(reply!.text).toBe("*Healthy*. See <https://runbook.example.com|the runbook>.");
    const [call] = world.claudeCalls();
    expect(call!.request).toBe("check web-01");
    expect(call!.prompt).toContain("@bob: web-01 is slow, @alice?");
    expect(call!.prompt).toContain('<thread venue="#ops">');
    expect(call!.system).toContain("answers mentions in Slack public channels");
    // The answer is posted before the run record is closed, so wait for the record.
    const run = await eventually("the finished run", () =>
      world!.runs().find((r) => r.status !== "running")
    );
    expect(run).toMatchObject({
      status: "succeeded",
      request: "check web-01",
      answer: "**Healthy**. See [the runbook](https://runbook.example.com).",
      context: { messages: 1 },
      origin: {
        messenger: "slack",
        conversation: ops.id,
        conversationLabel: "#ops",
        thread: root,
        message: ts,
        placeholder: reply!.ts,
        userId: alice.id,
        userName: "alice",
      },
    });
    expect(run!.origin.permalink).toBe(
      `${slack.url}/archives/${ops.id}/p${reply!.ts.replace(".", "")}?thread_ts=${root}&cid=${ops.id}`
    );
  });

  it("answers outside a thread in a new thread, with the channel's last messages as context", async () => {
    world = await World.create([{ match: "deploy", answer: "Deployed at 10:00." }]);
    const { slack, ops, alice, bob } = world;
    slack.post(ops.id, { user: bob.id, text: "the 10:00 deploy finished" });
    slack.post(ops.id, { user: alice.id, text: "anyone seeing errors?" });
    await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> when was the last deploy?`,
    });
    const [reply] = await world.answered(ops.id, ts);
    expect(reply!.thread_ts).toBe(ts);
    expect(reply!.text).toBe("Deployed at 10:00.");
    const prompt = world.claudeCalls()[0]!.prompt;
    expect(prompt).toContain("@bob: the 10:00 deploy finished");
    expect(prompt).toContain("@alice: anyone seeing errors?");
  });

  it("splits a long answer over several messages", async () => {
    const paragraph = (n: number) => `Section ${n}: ${"lorem ipsum ".repeat(170)}`.trim();
    world = await World.create([
      { match: "report", answer: [1, 2, 3].map(paragraph).join("\n\n") },
    ]);
    const { slack, ops, alice } = world;
    await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> full report please`,
    });
    // Each section is about 2,000 characters, so each fills one message (3,500 at most).
    const replies = await world.answered(ops.id, ts, 3);
    expect(replies).toHaveLength(3);
    expect(replies.every((reply) => reply.text.length <= 3500)).toBe(true);
    const text = replies.map((reply) => reply.text).join("\n");
    for (const n of [1, 2, 3]) expect(text).toContain(`Section ${n}:`);
  });

  it("records the reasoner's tool steps in the run history", async () => {
    world = await World.create([
      {
        match: "uptime",
        answer: "Up 3 days.",
        tools: [
          {
            name: "mcp__ops__host_check",
            input: { host: "web-01", check: "uptime" },
            result: "up 3 days",
          },
        ],
      },
    ]);
    const { slack, ops, alice } = world;
    await world.startBot();
    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> uptime of web-01?`,
    });
    await world.answered(ops.id, ts);
    const run = await eventually("the finished run", () =>
      world!.runs().find((r) => r.status === "succeeded")
    );
    expect(run.events).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        server: "ops",
        tool: "host_check",
        status: "completed",
        result: "up 3 days",
      })
    );
    expect(run.events).toContainEqual(expect.objectContaining({ kind: "usage" }));
  });

  it("tells a member who is not allowed, without asking the reasoner", async () => {
    world = await World.create();
    const { slack, ops, alice, bob } = world;
    await world.startBot({ MENTION_ALLOWED_USERS: alice.id });

    const ts = await slack.mention({
      channel: ops.id,
      user: bob.id,
      text: `<@${slack.botUserId}> hi`,
    });
    await eventually("the notice", () => slack.ephemerals.length > 0);
    expect(slack.ephemerals).toEqual([
      {
        channel: ops.id,
        user: bob.id,
        text: "This bot is only available to specific users.",
        thread_ts: undefined,
      },
    ]);
    await sleep(300);
    expect(slack.replies(ops.id, ts)).toEqual([]);
    expect(world.claudeCalls()).toEqual([]);
  });

  it("does not answer in a private channel", async () => {
    world = await World.create();
    const { slack, secret, alice } = world;
    await world.startBot();

    const ts = await slack.mention({
      channel: secret.id,
      user: alice.id,
      text: `<@${slack.botUserId}> hi`,
    });
    await eventually("the notice", () => slack.ephemerals.length > 0);
    expect(slack.ephemerals[0]).toMatchObject({
      user: alice.id,
      text: "This bot only answers in public channels.",
    });
    expect(slack.replies(secret.id, ts)).toEqual([]);
    expect(world.claudeCalls()).toEqual([]);
  });

  it("says an answer failed without showing the cause, and records the cause", async () => {
    world = await World.create([
      { match: "boom", fail: "API quota exceeded for org-123" },
    ]);
    const { slack, ops, alice } = world;
    await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> boom`,
    });
    const [reply] = await eventually("the failure message", () => {
      const replies = slack.replies(ops.id, ts);
      return replies[0]?.text.startsWith("Couldn't") ? replies : undefined;
    });
    expect(reply!.text).toBe(
      "Couldn't produce an answer. An error occurred while processing the request."
    );
    const run = await eventually("the failed run", () =>
      world!.runs().find((r) => r.status === "failed")
    );
    expect(run.error).toContain("API quota exceeded for org-123");
  });

  it("reads attached files: text and images, files that need a lookup, and says which it could not read", async () => {
    world = await World.create([{ match: "attached", answer: "Read them." }]);
    const { slack, ops, alice } = world;
    slack.addFile({
      id: "F0LOG",
      name: "app.log",
      mimetype: "text/plain",
      content: Buffer.from("ERROR db timeout at 10:02\n"),
    });
    slack.addFile({
      id: "F0PNG",
      name: "graph.png",
      mimetype: "image/png",
      content: PNG,
    });
    slack.addFile({
      id: "F0CFG",
      name: "values.yaml",
      mimetype: "text/plain",
      filetype: "yaml",
      content: Buffer.from("replicas: 3\n"),
      access: "summary",
    });
    slack.addFile({
      id: "F0DENY",
      name: "secret.txt",
      mimetype: "text/plain",
      content: Buffer.from("nope"),
      access: "denied",
    });
    await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> what do the attached files say?`,
      files: ["F0LOG", "F0PNG", "F0CFG", "F0DENY"],
    });
    await world.answered(ops.id, ts);
    const [call] = world.claudeCalls();
    expect(call!.images).toBe(1);
    expect(call!.prompt).toContain("ERROR db timeout at 10:02");
    expect(call!.prompt).toContain("replicas: 3");
    expect(call!.prompt).toMatch(/Unreadable attachment: secret\.txt - Got a login page/);
    expect(slack.callsTo("files.info").map((c) => c.args.file)).toEqual(["F0CFG"]);
    const run = await eventually("the finished run", () =>
      world!.runs().find((r) => r.status === "succeeded")
    );
    expect(run.attachments.map((a) => `${a.name}:${a.status}`).sort()).toEqual([
      "app.log:read",
      "graph.png:read",
      "secret.txt:failed",
      "values.yaml:read",
    ]);
  });

  it("answers a redelivered mention once", async () => {
    world = await World.create([{ match: "once", answer: "Just once.", delayMs: 500 }]);
    const { slack, ops, alice } = world;
    await world.startBot();

    const text = `<@${slack.botUserId}> answer once`;
    const ts = await slack.mention({ channel: ops.id, user: alice.id, text });
    await slack.mention({ channel: ops.id, user: alice.id, text, redeliver: { ts } });
    await world.answered(ops.id, ts);
    await sleep(500);
    expect(slack.replies(ops.id, ts)).toHaveLength(1);
    expect(world.claudeCalls()).toHaveLength(1);
  });

  it("finishes the answer in progress before stopping", async () => {
    world = await World.create([
      { match: "slow", answer: "Done slowly.", delayMs: 1_500 },
    ]);
    const { slack, ops, alice } = world;
    const bot = await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> slow one`,
    });
    await eventually("the reasoner to start", () => world!.claudeCalls().length === 1);
    await bot.stop();
    expect(slack.replies(ops.id, ts).map((reply) => reply.text)).toEqual([
      "Done slowly.",
    ]);
    expect(bot.output).toContain("waiting for in-progress requests");
  });

  it("resumes an answer cut off by a crash in the same message", async () => {
    world = await World.create([{ match: "crash", answer: "Survived.", delayMs: 3_000 }]);
    const { slack, ops, alice } = world;
    const first = await world.startBot();

    const ts = await slack.mention({
      channel: ops.id,
      user: alice.id,
      text: `<@${slack.botUserId}> crash test`,
    });
    await eventually("the reasoner to start", () => world!.claudeCalls().length === 1);
    await first.kill();

    await world.startBot();
    const [reply] = await world.answered(ops.id, ts);
    expect(reply!.text).toBe("Survived.");
    expect(reply!.edits).toEqual([
      "Working on an answer... (`claude@host`)",
      "The bot restarted. Resuming the answer... (`claude@host`)",
    ]);
    const run = await eventually("the resumed run", () =>
      world!.runs().find((r) => r.status === "succeeded")
    );
    expect(run.attempts).toBe(2);
    expect(world.runs()).toHaveLength(1);
  });

  it("stops at startup when Slack rejects the token", async () => {
    world = await World.create();
    world.slack.authError = "invalid_auth";
    const bot = world.track(startBot(world.botEnv()));
    const { code } = await bot.exited;
    expect(code).toBe(1);
    // The desktop app reads this to show "Setup needed" instead of a crash (bot-readiness.ts).
    expect(bot.output).toMatch(/Startup failed: .*invalid_auth/);
  });
});
