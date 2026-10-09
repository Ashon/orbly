import { describe, expect, it } from "vitest";
import { setupProblem, startFailureProblem } from "../apps/desktop/src/bot-readiness.js";

const TOKENS = { SLACK_BOT_TOKEN: "xoxb-1-abc", SLACK_APP_TOKEN: "xapp-1-abc" };

describe("bot readiness", () => {
  it("a first run without Slack tokens needs setup, not a crash", () => {
    const problem = setupProblem({});
    expect(problem).toMatchObject({ kind: "slack", issues: [] });
    expect(problem?.message).toMatch(/Settings/);
    // A blank value in .env counts as missing too.
    expect(setupProblem({ SLACK_BOT_TOKEN: " ", SLACK_APP_TOKEN: "xapp-1" })?.kind).toBe(
      "slack"
    );
  });

  it("valid settings are ready to start", () => {
    expect(setupProblem(TOKENS)).toBeUndefined();
  });

  it("other invalid values list the bot's own validation issues", () => {
    const problem = setupProblem({ ...TOKENS, OPS_TOOLS: "on" });
    expect(problem?.kind).toBe("config");
    expect(problem?.issues.map((issue) => issue.key)).toContain("OPS_TOOLS");
  });

  it("tokens Slack rejects need setup; other start failures do not", () => {
    const rejected = startFailureProblem([
      "INFO  [orbly] Starting (pid 1, desktop)",
      "ERROR [orbly] Startup failed: An API error occurred: invalid_auth",
    ]);
    expect(rejected).toMatchObject({ kind: "slack" });
    expect(rejected?.message).toMatch(/invalid_auth/);
    expect(startFailureProblem(["Error: Cannot find module 'x'"])).toBeUndefined();
    expect(startFailureProblem([])).toBeUndefined();
  });
});
