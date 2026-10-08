import { describe, expect, it } from "vitest";
import { claudeArgs, codexArgs, parseClaudeOutput } from "../src/reasoner/index.js";

describe("claudeArgs", () => {
  it("기본은 도구 없이, 사용자 설정과 MCP 를 읽지 않는다", () => {
    const args = claudeArgs({ system: "sys", model: "claude-opus-5-5", readOnly: false });
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config"]));
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    // 진행 단계를 기록하려고 출력은 항상 stream-json 이다.
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).not.toContain("--input-format");
  });

  it("읽기 전용이면 읽기 도구만 허용하고 나머지는 자동 거부한다", () => {
    const args = claudeArgs({ system: "sys", readOnly: true });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).not.toContain("--model");
  });
});

describe("MCP 서버 연결", () => {
  const ops = [{ name: "ops", url: "http://ops-broker:8080/mcp" }];

  it("claude 는 --mcp-config 로 붙이고 그 도구만 허용한다", () => {
    const args = claudeArgs({ system: "s", readOnly: false, mcpServers: ops });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__ops");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: { ops: { type: "http", url: "http://ops-broker:8080/mcp" } },
    });
  });

  it("claude 읽기 전용 도구와 MCP 도구를 함께 허용할 수 있다", () => {
    const args = claudeArgs({ system: "s", readOnly: true, mcpServers: ops });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,mcp__ops");
  });

  it("codex 는 -c mcp_servers.<name>.url 로 붙인다", () => {
    const args = codexArgs({ mcpServers: ops });
    expect(args).toContain('mcp_servers.ops.url="http://ops-broker:8080/mcp"');
    expect(args).toContain('mcp_servers.ops.default_tools_approval_mode="approve"');
    expect(args.at(-1)).toBe("-");
  });
});

describe("codexArgs", () => {
  it("read-only 샌드박스, 승인 요청 없음, 임시 세션, stdin 프롬프트로 실행한다", () => {
    const args = codexArgs({});
    expect(args[0]).toBe("exec");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--json");
    expect(args[args.indexOf("--disable") + 1]).toBe("apps");
    expect(args).not.toContain("--model");
    expect(args.at(-1)).toBe("-");
  });

  it("모델과 추론 강도를 넘길 수 있다", () => {
    const args = codexArgs({ model: "m1", reasoningEffort: "medium" });
    expect(args[args.indexOf("--model") + 1]).toBe("m1");
    expect(args).toContain('model_reasoning_effort="medium"');
  });
});

describe("parseClaudeOutput", () => {
  it("성공 결과만 텍스트로 돌려준다", () => {
    expect(
      parseClaudeOutput(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: " 네 \n",
        })
      )
    ).toBe("네");
    expect(() =>
      parseClaudeOutput(
        JSON.stringify({ subtype: "success", is_error: true, result: "boom" })
      )
    ).toThrow(/boom/);
    expect(() => parseClaudeOutput("not json")).toThrow(/JSON/);
  });
});
