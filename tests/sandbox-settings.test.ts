import { describe, expect, it } from "vitest";
import { configFingerprint } from "../src/config.js";
import {
  checkAllowlist,
  domainProblem,
  parseAllowlist,
  updateAllowlist,
} from "../src/sandbox/allowlist.js";
import { brokerExpected, checkBrokerEnv } from "../src/sandbox/env.js";
import { brokerRuntimeDir, envFilePath, verdaHome } from "../src/settings/paths.js";
import { computePending, parseHealthz, pickEnv } from "../src/sandbox/status.js";

const ALLOWLIST = `# 샌드박스 컨테이너가 접속할 수 있는 도메인

# claude CLI (Anthropic API)
api.anthropic.com

# codex CLI
chatgpt.com
auth.openai.com
api.openai.com
`;

describe("허용 도메인", () => {
  it("정확한 호스트 이름만 받는다", () => {
    expect(domainProblem("api.github.com")).toBeUndefined();
    expect(domainProblem("*.github.com")).toMatch(/와일드카드/);
    expect(domainProblem("https://github.com")).toMatch(/호스트 이름만/);
    expect(domainProblem("github.com:22")).toMatch(/포트/);
    expect(domainProblem("10.0.0.1")).toMatch(/IP/);
    expect(domainProblem("localhost")).toMatch(/형식/);
  });

  it("주석은 두고 빠진 도메인은 지우고 새 도메인은 끝에 붙인다", () => {
    expect(parseAllowlist(ALLOWLIST)).toEqual([
      "api.anthropic.com",
      "chatgpt.com",
      "auth.openai.com",
      "api.openai.com",
    ]);
    const next = updateAllowlist(ALLOWLIST, [
      "chatgpt.com",
      "auth.openai.com",
      "api.openai.com",
      "API.Example.com",
    ]);
    expect(next).toBe(`# 샌드박스 컨테이너가 접속할 수 있는 도메인

# claude CLI (Anthropic API)

# codex CLI
chatgpt.com
auth.openai.com
api.openai.com

# Verda 앱 설정 화면에서 추가
api.example.com
`);
  });

  it("지금 쓰는 CLI 에 필요한 도메인은 지울 수 없다", () => {
    expect(
      checkAllowlist(["chatgpt.com", "auth.openai.com", "api.openai.com"], "codex")
    ).toEqual([]);
    expect(checkAllowlist(["chatgpt.com"], "codex")).toEqual([
      { domain: "auth.openai.com", message: "codex 가 동작하려면 필요합니다." },
      { domain: "api.openai.com", message: "codex 가 동작하려면 필요합니다." },
    ]);
    expect(checkAllowlist(["api.anthropic.com", "*.x.com"], "claude")[0]?.domain).toBe(
      "*.x.com"
    );
  });
});

describe("broker 설정", () => {
  it("compose 에 넘기는 경로는 절대 경로, 대역과 조직은 형식을 검사한다", () => {
    expect(
      checkBrokerEnv({
        OPS_FS_ROOT: "/Users/me/git",
        OPS_SSH_ALLOWED_CIDR: "192.168.10.0/24",
      })
    ).toEqual([]);
    expect(checkBrokerEnv({ OPS_FS_ROOT: "~/git" })).toEqual([
      { key: "OPS_FS_ROOT", message: expect.stringContaining("절대 경로") },
    ]);
    expect(checkBrokerEnv({ OPS_SSH_ALLOWED_CIDR: "192.168.10.0" })[0]?.key).toBe(
      "OPS_SSH_ALLOWED_CIDR"
    );
    expect(checkBrokerEnv({ OPS_GIT_ALLOWED_OWNERS: "a b" })[0]?.key).toBe(
      "OPS_GIT_ALLOWED_OWNERS"
    );
    expect(checkBrokerEnv({ OPS_SSH_INVENTORY: "../x" })[0]?.key).toBe(
      "OPS_SSH_INVENTORY"
    );
    expect(checkBrokerEnv({ OPS_K8S_CONTEXTS: "main, staging" })).toEqual([]);
    expect(
      checkBrokerEnv({
        OPS_JIRA_URL: "https://your-site.atlassian.net",
        OPS_JIRA_EMAIL: "me@example.com",
        OPS_JIRA_PROJECTS: "PROJ, ops_2",
      })
    ).toEqual([]);
    expect(checkBrokerEnv({ OPS_JIRA_URL: "http://jira.local" })[0]?.key).toBe(
      "OPS_JIRA_URL"
    );
    expect(checkBrokerEnv({ OPS_JIRA_PROJECTS: "PROJ OPS" })[0]?.key).toBe(
      "OPS_JIRA_PROJECTS"
    );
    expect(checkBrokerEnv({ OPS_K8S_CONTEXTS: "main staging" })[0]?.key).toBe(
      "OPS_K8S_CONTEXTS"
    );
  });

  it("설정 파일과 broker 생성 파일은 저장소 밖(VERDA_HOME, 기본 ~/.verda)에 둔다", () => {
    expect(verdaHome({}, "/home/me")).toBe("/home/me/.verda");
    expect(envFilePath({}, "/home/me")).toBe("/home/me/.verda/.env");
    expect(brokerRuntimeDir({}, "/home/me")).toBe("/home/me/.verda/ops-broker");
    expect(envFilePath({ VERDA_HOME: "~/work/verda" }, "/home/me")).toBe(
      "/home/me/work/verda/.env"
    );
    expect(brokerRuntimeDir({ VERDA_HOME: "/srv/verda " }, "/home/me")).toBe(
      "/srv/verda/ops-broker"
    );
  });

  it("비운 기능은 기본값 없이 꺼지고, 마운트는 빈 자리를 가리킨다", () => {
    const runtime = "/home/me/.verda/ops-broker";
    expect(brokerExpected({}, runtime)).toEqual({
      sshUser: "",
      allowedCidr: "",
      allowedOwners: "",
      jiraUrl: "",
      jiraEmail: "",
      jiraProjects: "",
      configured: { fsRoot: false, ssh: false },
      fsRoot: `${runtime}/unset/workspace`,
      sshKey: `${runtime}/unset/ssh-key`,
      knownHosts: `${runtime}/unset/known_hosts`,
    });
    expect(
      brokerExpected(
        {
          OPS_SSH_USER: "ops",
          OPS_SSH_ALLOWED_CIDR: "192.168.10.0/24",
          OPS_SSH_KEY: "/home/me/.ssh/id_ed25519",
          OPS_FS_ROOT: "/home/me/workspaces",
        },
        runtime
      )
    ).toMatchObject({
      configured: { fsRoot: true, ssh: true },
      fsRoot: "/home/me/workspaces",
      sshKey: "/home/me/.ssh/id_ed25519",
      knownHosts: `${runtime}/unset/known_hosts`,
    });
  });
});

describe("상태 판정", () => {
  it("broker 상태 확인 결과를 읽는다", () => {
    expect(
      parseHealthz(
        "ok hosts=3 k8s=[] fs=/workspace git=on github=acme|acme-labs jira=PROJ|OPS"
      )
    ).toEqual({
      sshHosts: 3,
      k8s: [],
      fs: "/workspace",
      git: true,
      github: ["acme", "acme-labs"],
      jira: ["PROJ", "OPS"],
    });
    expect(
      parseHealthz("ok hosts=0 k8s=[main,staging] fs=off git=off github=off")
    ).toEqual({
      sshHosts: 0,
      k8s: ["main", "staging"],
      fs: undefined,
      git: false,
      github: [],
      jira: [],
    });
    expect(parseHealthz("error")).toBeUndefined();
  });

  it("broker 환경 변수에서 비교할 값만 고른다 (토큰은 읽지 않는다)", () => {
    expect(
      pickEnv(["SSH_USER=ops", "GH_TOKEN=gho_secret", "A=b=c"], ["SSH_USER", "A"])
    ).toEqual({
      SSH_USER: "ops",
      A: "b=c",
    });
  });

  it("바뀐 설정이 적용되지 않은 구성 요소와 이유를 찾는다", () => {
    const expected = brokerExpected(
      {
        OPS_GIT_ALLOWED_OWNERS: "acme, acme-labs, new-org",
        OPS_SSH_USER: "ops",
        OPS_SSH_ALLOWED_CIDR: "192.168.10.0/24",
        OPS_SSH_KEY: "/h/.ssh/id_ed25519",
        OPS_FS_ROOT: "/h/workspaces",
      },
      "/h/.verda/ops-broker"
    );
    const pending = computePending({
      bot: { configHash: "aaa", expectedHash: "bbb" },
      proxy: { running: true, startedAt: 1000, allowlistMtime: 2000 },
      broker: {
        running: true,
        startedAt: 1000,
        imageOutdated: false,
        imageCreatedAt: 500,
        sourceMtime: 400,
        env: {
          SSH_USER: "ops",
          ALLOWED_CIDR: "192.168.10.0/24",
          GIT_ALLOWED_OWNERS: "acme,acme-labs",
          GIT_AUTHOR_NAME: "me",
          GIT_AUTHOR_EMAIL: "me@personal.example",
        },
        mounts: {
          "/workspace": "/h/workspaces",
          "/run/secrets/ssh-key": "/h/.ssh/id_ed25519",
        },
        hostsMtime: 900,
        kubeconfigMtime: 1500,
        expected,
        author: { name: "me", email: "me@work.example" },
      },
    });
    expect(pending).toEqual([
      { component: "bot", reason: expect.stringContaining(".env") },
      { component: "proxy", reason: expect.stringContaining("허용 도메인") },
      {
        component: "broker",
        reason: ".env 와 다릅니다: GitHub 허용 조직, PR 커밋 작성자",
      },
      { component: "broker", reason: expect.stringContaining("kubeconfig") },
    ]);
    expect(
      computePending({
        bot: { configHash: "same", expectedHash: "same" },
        proxy: { running: false },
        broker: { running: false, imageOutdated: false, env: {}, mounts: {}, expected },
      }).map((p) => p.reason)
    ).toEqual(["프록시가 실행 중이 아닙니다.", "broker 가 실행 중이 아닙니다."]);
  });

  it("설정 지문은 봇 설정 값으로만 정해지고 데이터 위치는 보지 않는다", () => {
    const base = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1", PATH: "/bin" };
    expect(configFingerprint(base)).toBe(
      configFingerprint({ ...base, PATH: "/usr/bin", VERDA_DATA_DIR: "/x" })
    );
    expect(configFingerprint(base)).not.toBe(
      configFingerprint({ ...base, LOG_LEVEL: "debug" })
    );
    expect(configFingerprint(base)).toBe(configFingerprint({ ...base, LOG_LEVEL: " " }));
  });
});
