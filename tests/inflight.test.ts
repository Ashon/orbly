import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  InflightStore,
  MAX_ATTEMPTS,
  MAX_RESUME_AGE_MS,
  resumeDecision,
  type InflightEntry,
} from "../src/mention/inflight.js";

const dir = mkdtempSync(path.join(tmpdir(), "inflight-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (key: string, extra: Partial<InflightEntry> = {}): InflightEntry => ({
  key,
  event: { channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> draw it" },
  threadTs: "1.0",
  label: "#general",
  placeholderTs: "1.1",
  attempts: 1,
  startedAt: 1_000_000,
  ...extra,
});

describe("InflightStore", () => {
  it("records and removes requests", () => {
    const store = new InflightStore(path.join(dir, "a", "inflight.json"));
    expect(store.list()).toEqual([]);
    store.upsert(entry("C1:1.0"));
    store.upsert(entry("C1:2.0"));
    store.upsert(entry("C1:1.0", { attempts: 2 }));
    expect(store.list().map((e) => [e.key, e.attempts])).toEqual([
      ["C1:2.0", 1],
      ["C1:1.0", 2],
    ]);
    store.remove("C1:2.0");
    expect(store.list().map((e) => e.key)).toEqual(["C1:1.0"]);
  });

  it("treats a corrupt file as an empty list", () => {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{not json");
    expect(new InflightStore(file).list()).toEqual([]);
  });
});

describe("resumeDecision", () => {
  it("resumes only once and gives up on old requests", () => {
    const now = 1_000_000 + 60_000;
    expect(resumeDecision(entry("k", { attempts: 1 }), now)).toBe("resume");
    expect(resumeDecision(entry("k", { attempts: MAX_ATTEMPTS }), now)).toBe("give_up");
    expect(resumeDecision(entry("k"), 1_000_000 + MAX_RESUME_AGE_MS + 1)).toBe("give_up");
  });
});
