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
  event: { channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> 그려줘" },
  threadTs: "1.0",
  label: "#general",
  placeholderTs: "1.1",
  attempts: 1,
  startedAt: 1_000_000,
  ...extra,
});

describe("InflightStore", () => {
  it("요청을 기록하고 지운다", () => {
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

  it("깨진 파일은 빈 목록으로 본다", () => {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{not json");
    expect(new InflightStore(file).list()).toEqual([]);
  });
});

describe("resumeDecision", () => {
  it("한 번만 이어서 처리하고, 오래된 요청은 포기한다", () => {
    const now = 1_000_000 + 60_000;
    expect(resumeDecision(entry("k", { attempts: 1 }), now)).toBe("resume");
    expect(resumeDecision(entry("k", { attempts: MAX_ATTEMPTS }), now)).toBe("give_up");
    expect(resumeDecision(entry("k"), 1_000_000 + MAX_RESUME_AGE_MS + 1)).toBe("give_up");
  });
});
