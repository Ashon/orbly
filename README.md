<p align="center">
  <img src="assets/verda-icon-256.png" alt="Verda" width="96" height="96">
</p>

# Verda

공개 채널에서 봇이 멘션되면 스레드 맥락을 모아 로컬 `claude` 또는 `codex` CLI 에 추론을 맡기고,
돌아온 답을 같은 스레드에 봇 이름으로 올리는 Slack 봇.

Socket Mode 로 연결해서 공개 엔드포인트가 필요 없고, 봇 토큰의 최소 권한만 쓴다.

## 동작

```
공개 채널에서 @봇 멘션
  -> Bolt (Socket Mode, app_mention 이벤트)
  -> 허용 사용자 / 공개 채널 확인
  -> 스레드에 "답변 작성 중..." 게시
  -> 스레드 맥락 수집 (스레드면 전체, 아니면 직전 10건)
  -> Reasoner: claude -p 또는 codex exec (REASONER_SANDBOX=docker 면 일회용 컨테이너)
  -> "답변 작성 중..." 을 답변으로 교체 (길면 이어서 게시)
```

- 스레드 안에서 다시 멘션하면 봇의 이전 답변까지 맥락으로 넘겨서 이어서 답한다.
- `MENTION_ALLOWED_USERS` 를 지정하면 그 사람들의 멘션에만 답한다. 다른 사람에게는 본인에게만 보이는
  안내 메시지(ephemeral)를 보낸다.
- 비공개 채널, DM 에서는 답하지 않는다.
- 동시에 `MENTION_CONCURRENCY` 개까지 실행하고, 넘치는 요청은 10건까지 대기한다. 그 이상이면 바쁘다고 답한다.
- 실패하면 자리표시 메시지를 "답변을 만들지 못했습니다" 로 바꾼다. 공개 채널이라 오류 내용은 로그에만 남긴다.

### 첨부 파일
멘션 메시지와 스레드에 붙은 파일을 봇 토큰(`files:read`)으로 내려받아 함께 넘긴다. 요청 메시지의 첨부가 먼저,
그다음 스레드의 최근 첨부 순서다. 이벤트에 요약본(`file_access: check_file_info`)으로 온 파일은 `files.info` 로 다시 조회한다.

| 종류 | 처리 | 제한 |
| --- | --- | --- |
| 이미지 (png, jpg, gif, webp) | codex 는 `/attachments` 읽기 전용 마운트 + `--image`, claude 는 stdin base64 블록 | 장당 10MB, 최대 4장 |
| 텍스트 (로그, 설정, 코드, JSON/YAML/CSV, Slack 스니펫, SVG) | 내용을 `<attached_file>` 데이터 영역으로 프롬프트에 넣음 | 파일당 2MB, 5만 자, 전체 12만 자 |
| PDF | 네트워크 없는 일회용 컨테이너(`pdftotext`)에서 앞 50쪽 텍스트만 추출 | 20MB, 텍스트 계열과 합쳐 최대 4개 |
| 그 밖의 형식, 외부 파일(Google Drive 등) | 읽지 않고 이름과 이유를 모델에 알림 | |

- 첨부 안의 지시문은 데이터로만 다룬다. 내려받은 파일은 `data/attachments/<id>` 에 두었다가 답변이 끝나면 지운다.
  (colima 는 홈 아래 경로만 컨테이너에 마운트되므로 `/tmp` 를 쓰지 않는다.)
- 권한이 없으면 Slack 이 파일 대신 로그인 페이지를 돌려주는데, 이 경우 "files:read 권한 확인" 으로 표시한다.

### 그림 그리기
답변에 그림이 도움이 되면 모델이 ` ```mermaid `, ` ```dot `(graphviz), ` ```vega-lite `, ` ```svg ` 코드 블록을 쓴다.
봇이 이 블록을 PNG 로 그려 스레드에 올리고(`files:write`), 본문에는 `(그림 N)` 표시만 남긴다.

- 렌더링은 네트워크 없는 일회용 컨테이너(`sandbox/renderer`: mermaid-cli + chromium, graphviz, vl-convert, librsvg,
  Noto CJK 폰트)에서 한다. 읽기 전용 루트, 권한 제거, 메모리/프로세스 제한.
- 한 답변에 최대 3개. 그리지 못한 블록은 원문 코드와 안내를 남기고, 업로드에 실패하면 원문을 스레드에 올린다.
- vega-lite 는 외부 데이터를 불러오지 못하므로 `data.values` 에 값을 직접 넣는다. 크기를 안 정하면 520x260 으로 그린다.
- `RENDER_DIAGRAMS=off` 로 끌 수 있다. 렌더링 이미지가 없으면 시작 로그에 남기고 그림 없이 동작한다.

일러스트, 사진 같은 그림은 codex 의 이미지 생성 기능(`image_generation`)으로 만든다. (claude 백엔드는 없음)

- codex 는 생성 이미지를 `~/.codex/generated_images` 에 저장한다. 샌드박스 컨테이너에서는 요청마다
  `data/attachments/<id>/generated` 를 `/out` 으로 마운트하고, entrypoint 가 이 경로를 `/out` 으로 이어서 호스트에 남긴다.
  컨테이너에서 호스트로 쓸 수 있는 경로는 이것 하나다.
- 봇이 답변 뒤에 생성 이미지(최대 4장)와 다이어그램을 함께 스레드에 올린다. 생성에는 1분 안팎이 걸린다.
- codex 는 정해진 크기(1024x1024, 1536x1024 등)로만 생성하므로, 크기/비율 요청이 없으면 정사각형으로 만들게 하고
  올리기 전에 렌더링 컨테이너(Pillow)에서 긴 변을 `GENERATED_IMAGE_MAX_PX`(기본 512) 로 줄인다. 0 이면 원본.
- 스레드에 이미지가 있으면 함께 넘기므로, 앞서 올린 이미지를 참고해서 그릴 수 있다.

| 경로 | 역할 |
| --- | --- |
| `src/index.ts` | 앱 조립, 이벤트 연결 |
| `src/mention/responder.ts` | 멘션 처리, 맥락 수집, 답변 게시 |
| `src/reasoner/` | `claude -p`, `codex exec` 실행 래퍼, 호스트/도커 실행기 |
| `src/broker/` | ops-broker: SSH 호스트 점검, k8s 조회, 작업 디렉터리 읽기 (MCP 서버) |
| `src/tools/ops-prepare.ts` | broker 마운트 준비, 인벤토리로 호스트 목록 생성 (`pnpm ops:prepare`) |
| `src/tools/k8s-kubeconfig.ts` | 조회 전용 SA 토큰으로 broker kubeconfig 생성 (`pnpm k8s:kubeconfig`) |
| `src/slack/` | 사용자/채널 정보 캐시, mrkdwn 변환 |
| `src/tools/check-slack.ts` | Slack 앱 설정 점검 (`pnpm slack:check`) |
| `sandbox/` | 추론 컨테이너 이미지, egress 프록시, compose |

## 추론 백엔드

| REASONER | 실행 방식 | 제한 |
| --- | --- | --- |
| `claude` (기본) | `claude -p --output-format json` | 사용자 설정, 훅, MCP 를 읽지 않음. 기본은 도구 없음, `MENTION_WORKSPACE` 가 있으면 `Read,Grep,Glob` 만 허용 |
| `codex` | `codex exec --sandbox read-only --ephemeral` | 셸 도구를 끌 수 없어 read-only 샌드박스와 `approval_policy=never` 로 제한 |

## 추론 샌드박스
멘션한 사람의 요청과 스레드 내용이 그대로 모델 입력이 된다. `REASONER_SANDBOX=docker` 이면 추론을
요청마다 새 컨테이너에서 실행하고 끝나면 지운다.

```
봇(호스트) --docker run--> 추론 컨테이너 --(internal 네트워크)--> egress-proxy --> 허용 도메인만
                            |- /workspace  참고 디렉터리 (읽기 전용, 선택)
                            |- HOME, /tmp  매번 비어 있는 tmpfs
                            '- 그 외 호스트 파일 없음
```

| 항목 | 제한 |
| --- | --- |
| 파일시스템 | 루트 읽기 전용. 호스트에서 보이는 것은 참고 디렉터리(ro)와 codex 인증 파일(ro)뿐 |
| 네트워크 | 외부 라우팅 없는 `internal` 네트워크. `sandbox/proxy/allowed-domains.txt` 의 도메인만 443 CONNECT 허용 |
| 권한 | 모든 capability 제거, `no-new-privileges`, uid 1000, pids/메모리/CPU 제한 |
| 인증 | claude 는 `SANDBOX_CLAUDE_OAUTH_TOKEN` 또는 `SANDBOX_ANTHROPIC_API_KEY` 를 환경 변수 이름으로만 넘김(프로세스 인자 노출 없음). codex 는 `auth.json` 을 읽기 전용 마운트 후 tmpfs 로 복사 |
| 실패 시 | 이미지, 네트워크, 프록시가 없으면 시작 로그에 남기고 추론 호출은 실패한다. 호스트 실행으로 대신하지 않는다. |

백엔드별 동작:

- `claude`: 셸 도구가 없어서 샌드박스 안에서도 `/workspace` 를 `Read,Grep,Glob` 으로 참고할 수 있다.
  참고 디렉터리가 필요하면 이 조합을 권장한다.
- `codex`: 강화된 컨테이너 안에서는 codex 자체 샌드박스(bubblewrap)가 namespace 를 만들 수 없어 셸 명령이
  모두 거부된다. 바깥 격리를 풀지 않기 위해 이 상태를 유지하고, 참고 디렉터리는 마운트하지 않는다.
  즉 스레드 맥락만 보고 답한다. 모델은 `~/.codex/config.toml` 의 `model`, `model_reasoning_effort` 를 읽어 넘긴다.

도메인 허용 목록은 모델 API 도메인을 열어 두므로, 그 API 를 통한 우회 전송까지 막지는 못한다.
그래서 샌드박스 안에서는 셸 도구가 동작하지 않는 구성(claude 는 셸 없음, codex 는 명령 거부)을 유지한다.

준비:

```sh
pnpm sandbox:build     # 추론 이미지(claude, codex CLI), 렌더링 이미지, 프록시 이미지 빌드
pnpm sandbox:up        # egress 프록시와 내부 네트워크 시작 (allowed-domains.txt 변경 후에도 실행)
claude setup-token     # claude 백엔드를 쓸 때: 구독 토큰 발급 -> .env 의 SANDBOX_CLAUDE_OAUTH_TOKEN
```

CLI 버전은 `sandbox/compose.yaml` 의 build args 로 고정되어 있다. 호스트 CLI 를 올리면 같이 올리고 다시 빌드한다.

## 운영 도구 (ops-broker)
`OPS_TOOLS=on` 이면 추론 CLI 가 운영 상태를 조회하고, 코드를 고쳐 draft PR 을 만들 수 있다. 자격 증명과 작업 디렉터리는 추론 컨테이너에
넣지 않고, 별도의 중계 컨테이너(`ops-broker`)만 가진다. 추론 컨테이너는 MCP 도구로 정해진 조회만 요청한다.

```
추론 컨테이너 --MCP(http, internal 네트워크)--> ops-broker --ssh OPS_SSH_USER--> 인벤토리 호스트 (OPS_SSH_ALLOWED_CIDR 안)
  (자격 증명 없음, 셸 없음/거부)                   (키/토큰 보유)  --kubectl (조회 전용 SA)--> OPS_K8S_CONTEXTS 클러스터
                                                                  --읽기 전용 마운트--> OPS_FS_ROOT
                                                                  --git(https, 사용자 토큰)--> GitHub (verda/* 브랜치, draft PR)
                                                                  --REST(사용자 토큰, 읽기)--> GitHub (저장소, PR 조회)
                                                                  --REST(API 토큰)--> Jira (허용 프로젝트 조회, 이슈 생성/댓글)
```

| 도구 | 내용 | 제한 |
| --- | --- | --- |
| `host_list`, `host_check` | 호스트 SSH 점검: `uptime`, `dmesg`, `memory`, `disk`, `top`, `pci_devices`, `failed_units`, `service`, `journal` | 정해진 점검과 형식 검증된 인자만. 호스트 목록의 이름으로만 지정, `OPS_SSH_ALLOWED_CIDR` 안 |
| `k8s_get`, `k8s_describe`, `k8s_logs`, `k8s_events`, `k8s_top` | kubectl 조회 | 조회 전용 SA(`sandbox/k8s/verda-ro.yaml`, ClusterRole `view` 와 클러스터 범위 조회) 로 클러스터 쪽에서 강제. secrets 는 RBAC 와 broker 양쪽에서 차단 |
| `fs_list`, `fs_find`, `fs_search`, `fs_read` | 작업 디렉터리 읽기 | 읽기 전용 마운트. `.env`, 키, kubeconfig, `*secret*`, `.git`, `.venv` 등 제외. 루트 밖과 루트 밖을 가리키는 링크 거부. 검색은 저장소 이상으로 범위 지정 필수 |
| `ws_prepare`, `ws_read`, `ws_search`, `ws_list`, `ws_edit`, `ws_write`, `ws_delete`, `ws_diff`, `ws_create_pr` | 코드 수정과 draft PR | 아래 "코드 수정과 PR" 참고 |
| `gh_repo_search`, `gh_pr_list`, `gh_pr_search`, `gh_pr_view`, `gh_pr_diff` | GitHub 저장소 검색, PR 목록/검색, PR 상세(리뷰, CI 체크, 변경 파일), diff | 읽기 전용. `OPS_GIT_ALLOWED_OWNERS` 조직만. 조직 없이 저장소 이름만 주면 허용 조직에서 찾고, 없으면 비슷한 저장소를 알려 준다 |
| `jira_search`, `jira_issue`, `jira_create_issue`, `jira_add_comment` | Jira JQL 검색, 이슈 상세(설명, 하위/연결 이슈, 최근 댓글), 이슈 생성, 댓글 | `OPS_JIRA_PROJECTS` 프로젝트만 (JQL 은 프로젝트 조건으로 고정). 쓰기는 요청 시에만, 토큰 주인 계정으로 남고 시간당 20건 제한. 상태 변경 없음 |

- 모든 도구 출력은 토큰, 개인 키 같은 대표 형식의 비밀 값을 가린 뒤 돌려준다.
- Jira 는 broker 의 API 토큰(`OPS_JIRA_TOKEN`)으로만 다룬다. broker 가 직접 나가므로 프록시 허용 도메인에 Jira 를 열지 않는다.
- GitHub 은 broker 의 토큰(`gh auth token`)으로만 조회한다. 추론 컨테이너는 GitHub 로 나갈 수 없고 토큰도 없다.
  codex 의 ChatGPT 앱 커넥터(`codex_apps`, GitHub 커넥터 포함)는 권한 범위가 다르고 데이터가 다른 경로로 나가므로
  샌드박스 실행에서 끈다. (`codex exec --disable apps`)
- 모든 호출은 broker 로그(`docker logs verda-sandbox-ops-broker-1`)에 남는다.
- 자격 증명을 쓰므로 `REASONER_SANDBOX=docker` 와 `MENTION_ALLOWED_USERS` 가 없으면 봇이 시작하지 않는다.
- 점검을 늘리려면 `src/broker/checks.ts` (SSH) 또는 `src/broker/k8s.ts` 를 고치고 broker 를 다시 빌드한다.

### 코드 수정과 PR

- `ws_prepare(repo)`: 로컬 저장소 디렉터리 이름으로 `origin` 을 찾아, 허용 조직(`OPS_GIT_ALLOWED_OWNERS`)
  저장소면 원격 기본 브랜치에서 `verda/<날짜>-<id>` 브랜치 작업 공간을 만든다.
  작업 공간은 broker 볼륨(`ops-work`)의 미러 worktree 라서 사용자의 로컬 작업 트리와 진행 중인 변경은 바뀌지 않는다.
- 수정은 `ws_edit`(정확한 문자열 치환), `ws_write`, `ws_delete` 로만 한다. 셸 실행, 테스트 실행은 없다.
  검증은 PR 의 CI 와 사람의 리뷰가 맡는다.
- `ws_create_pr`: 정책 검사 후 커밋, `verda/*` 브랜치로만 push, draft PR 생성.
  - 거부: 변경 없음, `.github/workflows/`, `.gitmodules`, 비밀 파일 경로, diff 의 비밀 값 형식, 50개 초과 파일, 3000줄 초과 추가
  - 커밋 작성자는 `OPS_GIT_AUTHOR_NAME`, `OPS_GIT_AUTHOR_EMAIL`, 비우면 전역 git 설정(`git config --global`)의 사용자다.
    이 저장소의 git 설정과는 별개다. PR 은 `gh` 로그인 계정으로 만들어진다. 시간당 10개 제한.
- GitHub 토큰은 `pnpm sandbox:ops-up` 이 `gh auth token` 으로 읽어 broker 환경 변수로만 넘긴다. 모델은 볼 수 없다.
  `repo`, `workflow` 범위의 토큰이므로, 운영에서는 대상 저장소만 허용한 fine-grained PAT 로 바꾸는 것을 권장한다.
- 작업 공간은 24시간 뒤 정리된다.

준비: 대상 환경의 값은 코드에 두지 않고 모두 설정 파일(`~/.verda/.env`)의 `OPS_*` 로 넣는다. 기능마다 선택이며, 비워 둔 기능은 broker 가 그 도구 없이 뜬다.
호스트 목록, kubeconfig 같은 broker 생성 파일도 저장소 밖 `~/.verda/ops-broker/` 에 만든다.

| 기능 | 설정 | 비우면 |
| --- | --- | --- |
| 파일 조회 (`fs_*`) | `OPS_FS_ROOT` | 파일, PR 도구 꺼짐 |
| GitHub 조회, PR (`gh_*`, `ws_*`) | `OPS_GIT_ALLOWED_OWNERS` (+ `gh auth login`, 커밋 작성자 `OPS_GIT_AUTHOR_*`) | GitHub, PR 도구 꺼짐 |
| Jira (`jira_*`) | `OPS_JIRA_URL`, `OPS_JIRA_EMAIL`, `OPS_JIRA_TOKEN`, `OPS_JIRA_PROJECTS` | Jira 도구 꺼짐 |
| k8s 조회 (`k8s_*`) | `OPS_K8S_CONTEXTS`, `OPS_K8S_SA`, `OPS_K8S_SA_NAMESPACE` | kubeconfig 가 비어 k8s 도구 꺼짐 |
| 호스트 점검 (`host_*`) | `OPS_SSH_USER`, `OPS_SSH_ALLOWED_CIDR`, `OPS_SSH_KEY` (+ `OPS_SSH_KNOWN_HOSTS`) | 호스트 도구 꺼짐 |
| 호스트 목록 | `OPS_SSH_INVENTORY_DIR`, `OPS_SSH_INVENTORY` (ansible 인벤토리) | `~/.verda/ops-broker/hosts.json` 을 직접 쓴다 |

```sh
# 1) k8s 조회 전용 SA: 조회할 클러스터마다 sandbox/k8s/verda-ro.yaml 적용
# 2) SA 토큰으로 broker kubeconfig 생성 (로컬 관리자 kubeconfig 로 토큰 Secret 을 읽는다)
pnpm k8s:kubeconfig
# 3) 마운트 준비와 호스트 목록 생성(pnpm ops:prepare) 후 broker 빌드/시작
pnpm sandbox:ops-up
```

인벤토리나 SA 토큰이 바뀌면 해당 명령과 `pnpm sandbox:ops-up` 을 다시 실행한다.

## 설치

1. Slack 앱: https://api.slack.com/apps -> Create New App -> From an app manifest ->
   `slack-app-manifest.yaml` 붙여 넣기. 기존 앱을 쓴다면 아래 권한과 이벤트만 맞춘다.
   - Bot Token Scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `files:write`, `users:read`
   - Event Subscriptions > bot events: `app_mention`
   - Socket Mode 켜기
2. Basic Information -> App-Level Tokens 에서 `connections:write` 토큰 생성 -> `SLACK_APP_TOKEN`
3. 봇을 답하게 할 공개 채널에 초대한다. (`/invite @봇이름`)
4. 설정 파일 작성 후 점검. 설정은 저장소 밖 `~/.verda/.env` 에 둔다. (`VERDA_HOME` 으로 위치를 바꿀 수 있다)
   봇(앱, 터미널), 준비 명령, 샌드박스 compose 가 모두 이 파일을 읽고, 대상 환경의 값은 저장소에 남지 않는다.

   ```sh
   mkdir -p ~/.verda && cp .env.example ~/.verda/.env   # SLACK_*, REASONER, REASONER_SANDBOX 를 채운다.
   pnpm install
   pnpm slack:check        # 토큰, 스코프, 앱 일치, Socket Mode 확인
   ```

5. 실행

   ```sh
   pnpm desktop             # 데스크톱 앱이 봇을 띄우고 관리한다 (권장, 아래 "데스크톱 앱" 참고)
   pnpm dev                 # 터미널에서 개발 (watch)
   pnpm build && pnpm start # 터미널에서 실행
   ```

같은 앱 토큰으로 프로세스를 두 개 띄우면 Slack 이 이벤트를 나눠 보내므로 하나만 실행한다.
봇은 시작할 때 `VERDA_DATA_DIR/bot.json` 으로 실행 잠금을 잡는다. 다른 봇이 살아 있으면 30초 동안 끝나기를 기다리고,
그래도 살아 있으면 "다른 Verda 봇이 실행 중" 으로 종료한다.
`pnpm dev` 는 소스가 바뀔 때마다 프로세스를 다시 띄우므로, 코드를 고치는 동안에는 처리 중이던 요청이 끊길 수 있다.

재시작 처리:

- 처리 중인 멘션은 `data/inflight.json` 에 기록된다. 봇이 재시작되면 같은 "답변 작성 중" 메시지로 한 번 이어서 처리하고,
  이미 이어서 처리했거나 30분이 지난 요청은 "다시 멘션해 주세요" 로 바꾼다.
- 종료 신호(SIGINT, SIGTERM)를 받으면 새 이벤트를 받지 않고 처리 중인 요청을 최대 20초 기다린다.
- 시작할 때 1시간이 지난 첨부/산출물 임시 디렉터리(`data/attachments/*`)를 지운다.

요구 사항: Node.js 22.9 이상, pnpm 11, 샌드박스를 쓰면 Docker.

## 데스크톱 앱

데스크톱 앱(`apps/desktop`, Electron)은 봇(Socket Mode)을 자식 프로세스로 띄워 관리하고, 상태, 로그, 작업 기록을 보여 준다.
화면은 `apps/web`(React)이다.

```sh
pnpm desktop        # 봇, 화면, 앱을 빌드하고 실행
pnpm desktop:dev    # 화면은 Vite 개발 서버(127.0.0.1:5179), 앱은 그 주소를 연다
```

봇 관리:

- 앱을 열면 봇을 자동으로 띄운다. (트레이 메뉴, 봇 화면에서 끌 수 있다. 설정은 `VERDA_DATA_DIR/desktop.json`)
- 저장소의 `dist/index.js` 를 Electron utilityProcess 로 실행한다. `src` 가 더 새로우면 먼저 `pnpm build` 한다.
  환경 변수는 `node --env-file` 과 같이 설정 파일(`~/.verda/.env`)을 읽고, 이미 있는 환경 변수가 우선한다.
  PATH 는 로그인 셸에서 가져온다. (Finder 로 띄워도 docker, codex, pnpm 을 찾도록)
- 트레이와 봇 화면에서 시작, 중지, 재시작, 빌드 후 재시작을 한다. 처리 중인 요청 수는 메뉴 막대 아이콘 옆에 표시된다.
- 중지와 앱 종료는 SIGTERM 이다. 봇은 처리 중인 요청을 최대 20초 기다리고, 남은 요청은 다음 시작 때 이어서 처리한다.
- 30초 이상 정상 동작하다 죽으면 3초 뒤 다시 띄운다. (10분에 3번까지) 시작하자마자 죽으면 설정 문제로 보고 멈추고,
  원인과 마지막 출력을 봇 화면에 보여 준다.
- 터미널(`pnpm dev` 등)에서 이미 봇이 떠 있으면 건드리지 않고 "터미널에서 실행 중" 으로 상태와 로그만 보여 준다.
  터미널 봇을 끄면 앱이 이어서 관리한다. (자동 시작이 켜져 있으면 바로 띄운다)
- 창을 닫으면 트레이로 숨고 봇은 계속 동작한다. 종료는 트레이 메뉴나 Cmd+Q.
- `VERDA_DESKTOP_BOT=off` 이면 봇을 관리하지 않고 기록만 본다.

설정:

- 오른쪽 위 톱니바퀴(설정)에서 설정 파일(`~/.verda/.env`)을 고친다. 앱과 터미널 실행이 같은 파일을 쓰므로 설정이 갈라지지 않는다.
- 항목은 Slack 연결(Socket Mode), 응답 대상, 추론, 그림, 기록과 로그로 나뉘고, 자주 바꾸지 않는 값은 "고급 설정" 에 접혀 있다.
  항목 정의는 `src/settings/fields.ts` 하나이고, 기본값은 봇 설정(`src/config.ts`)과 같은지 테스트로 확인한다.
- 토큰 같은 비밀 값은 화면으로 보내지 않는다. 접두어와 끝 4자리만 보여 주고, 새 값을 입력해서 바꾼다.
- "연결 확인" 은 입력한 토큰(없으면 지금 값)으로 봇 토큰, 봇 스코프, 같은 앱인지, Socket Mode 를 확인한다.
  (`pnpm slack:check` 와 같은 검사, 접속 주소만 받고 연결은 하지 않는다)
- 저장 전에 봇과 같은 규칙으로 검증하고, 문제가 있으면 항목 옆에 보여 주고 저장하지 않는다.
- 저장할 때 주석, 순서, 설정 화면이 다루지 않는 항목(예: 개인 API 키)은 그대로 둔다. 기본값으로 되돌린 항목은 `KEY=` 로 비운다.
  새 항목은 끝에 모아 붙이고, 파일 권한(600)은 유지한다.
- 저장한 설정은 봇을 다시 시작해야 적용된다. "저장 후 봇 재시작" 으로 한 번에 할 수 있다.
- 앱의 환경 변수에 같은 항목이 있으면 `.env` 보다 우선하므로 화면에 따로 표시한다.
- Socket Mode 연결 유지 값: `SOCKET_CLIENT_PING_TIMEOUT_MS`(기본 5000), `SOCKET_SERVER_PING_TIMEOUT_MS`(기본 30000),
  `SOCKET_PING_PONG_LOG`(기본 off, `LOG_LEVEL=debug` 일 때 보인다)
- 설정 읽기/쓰기는 봇 제어처럼 앱 내부 IPC 로만 한다. 조회 API 와 브라우저 개발 서버에서는 설정을 바꿀 수 없다.

샌드박스 (설정의 "샌드박스" 탭):

- 샌드박스는 세 구성 요소로 나뉘고, 설정이 적용되는 방식이 다르다. 항목마다 "적용:" 으로 표시한다.

  | 구성 요소 | 설정 | 적용 |
  | --- | --- | --- |
  | 추론 샌드박스 (요청마다 새 컨테이너) | `SANDBOX_*`, `OPS_TOOLS` | 봇 재시작 |
  | 바깥 접속 허용 도메인 (egress-proxy) | `sandbox/proxy/allowed-domains.txt` | 프록시 재시작 (`pnpm sandbox:up`) |
  | ops-broker | `OPS_GIT_*`, `OPS_FS_ROOT`, `OPS_SSH_*`, `OPS_K8S_*`, `OPS_JIRA_*` | broker 다시 띄우기 (`pnpm sandbox:ops-up`) |

- 상태: docker, 이미지 4개, 프록시와 broker 컨테이너, broker 도구(SSH 호스트 수, k8s, 파일, GitHub, PR, Jira), 자격 증명 파일과
  gh 로그인, git 작성자. 자격 증명 값은 읽지 않고 있는지만 본다.
- 적용 필요: 바뀐 설정이 아직 적용되지 않은 구성 요소를 이유와 함께 보여 주고, 그 자리에서 적용한다.
  - 봇: 시작할 때 상태 파일에 남긴 설정 지문(`configHash`)이 지금 `.env` 로 계산한 값과 다를 때
  - 프록시: 프록시가 시작된 뒤 허용 목록이 바뀌었을 때, 또는 꺼져 있을 때
  - broker: 컨테이너 설정(SSH 사용자, 허용 대역, GitHub 조직, 마운트 경로)이 `.env` 와 다를 때, 새 이미지가 있거나
    `src/broker` 코드가 이미지보다 새로울 때, 호스트 목록이나 kubeconfig 가 broker 시작 뒤에 바뀌었을 때
- 허용 도메인은 정확한 호스트 이름만 받는다(와일드카드, IP, 포트, 주소 형식 거부). 지금 쓰는 추론 CLI 에 필요한 도메인은 뺄 수 없다.
  토큰이 필요한 내부 시스템은 도메인을 여는 대신 broker 도구로 붙인다.
- 적용 작업: 이미지 빌드(`sandbox:build`), kubeconfig 다시 만들기(`k8s:kubeconfig`), 프록시 재시작, broker 다시 띄우기를
  앱에서 실행하고 출력을 보여 준다. 한 번에 하나만 돌고, 출력의 비밀 값은 가린다.
  프록시와 broker 는 진행 중인 도구 호출을 끊으므로 처리 중인 요청이 있으면 막는다.
- broker 가 마운트하는 경로(`OPS_FS_ROOT`, `OPS_SSH_KEY`, `OPS_SSH_KNOWN_HOSTS`)는 절대 경로만 받는다. (compose 는 `~` 를 펼치지 않는다)

상태와 로그:

- 봇은 `VERDA_DATA_DIR/bot.json` 에 상태(Socket Mode 연결 상태와 재연결 수, 봇 계정, 추론 백엔드, 처리 중/처리한 요청 수,
  샌드박스 점검 문제)를 쓴다. 누가 띄웠든 앱이 같은 방식으로 읽는다.
- 로그는 콘솔과 함께 `VERDA_DATA_DIR/logs/bot.log` 에 남는다. (5MB 를 넘으면 `bot.log.1` 로 넘긴다)
  Bolt 와 Socket Mode 클라이언트 로그도 같은 로거로 보내서, scope 가 `verda:socket`, `verda:bolt` 로 남는다.
  연결, 재연결, 끊김, 이벤트 수신(envelope, 재전송 횟수)을 기록한다.
- 로그 파일에서는 토큰, 키 형식과 Socket Mode 접속 주소의 ticket 을 가린다.
- 봇 화면에서 로그를 전체, Socket Mode, 멘션 처리, 경고/오류로 나눠 보고 검색한다. 2초마다 새로 읽고 끝을 따라간다.
  `LOG_LEVEL=debug` 이면 Socket Mode 클라이언트의 상세 로그까지 남는다.

작업 기록:

```
~/.verda/runs/<YYYY-MM-DD>/<run id>/run.json      # 요청, 맥락 수, 첨부, 프롬프트, 단계, 답변, 상태
~/.verda/runs/<YYYY-MM-DD>/<run id>/artifacts/    # 모델에 넘긴 이미지, 올린 생성 이미지와 그림
```

- 봇은 멘션 하나를 처리할 때마다 실행 기록을 남긴다. (`HISTORY=on`, 기본값)
- 단계는 CLI 의 JSON 출력(codex `--json`, claude `stream-json`)에서 뽑는다. 메시지, 생각, 도구 호출(인자, 결과,
  소요 시간), 셸 명령, 토큰 사용량이 남는다. 도구 결과는 8,000자까지 저장한다.
- 상태는 진행 중, 완료, 실패, 중단이다. 재시작 후 이어서 처리하면 같은 기록에 "시도 2회째" 로 이어 쓰고,
  이어서 처리하지 않는 기록은 시작할 때 중단으로 표시한다.
- `HISTORY_RETENTION_DAYS`(기본 30일)보다 오래된 날짜 디렉터리는 지운다. 위치는 `VERDA_DATA_DIR` 로 바꾼다.
- 기록에는 스레드 맥락과 첨부 내용이 들어 있으므로 로컬에만 둔다.
- 화면: 실행 목록(상태 필터, 검색), 개요(최근 14일, 성공률, 평균 소요, 많이 쓴 도구), 실행 상세(요청 -> 도구 호출 ->
  답변 -> 산출물 순서의 작업 과정, 첨부, 프롬프트, 원본 JSON). 진행 중인 실행은 1.5초마다 새로 읽는다.

그 밖:

- 조회 API 는 앱 안의 `verda://app/api/*` 로만 제공하고 포트를 열지 않는다. 봇 제어는 preload IPC 로만 한다.
  개발 서버(`apps/web` Vite)는 127.0.0.1 에서만 받고, 같은 조회 API 를 읽기 전용으로 붙인다.
- 기록 위치는 `VERDA_DATA_DIR` 환경 변수, 설정 파일의 `VERDA_DATA_DIR`, `~/.verda` 순으로 정한다.
- 앱 아이콘: `assets/verda-icon.svg` 가 원본이다. 고친 뒤 `pnpm --filter @verda/desktop icon` (macOS swift) 으로
  같은 도형을 macOS 아이콘 격자(1024 중 824 본체, 그림자, 반사광)에 맞춘 `assets/verda-icon.png` 로 다시 그린다.
  개발 실행은 독 아이콘을 PNG 그대로 쓰므로 시스템 대신 이 처리를 직접 한다.
- `VERDA_DESKTOP_THEME=light|dark` 로 테마를 고정할 수 있다. (기본은 시스템 설정, 화면 오른쪽 위에서도 바꾼다)
- 빌드 확인: `VERDA_DESKTOP_CAPTURE=/tmp/verda.png pnpm --filter @verda/desktop start` 는 창을 띄우지 않고
  화면을 PNG 로 저장한 뒤 종료한다. (`VERDA_DESKTOP_CAPTURE_HASH=#/bot` 으로 화면 지정, 이때 봇은 띄우지 않는다)

## 개발

```sh
pnpm check   # typecheck(봇, 화면, 앱) + lint + format:check + test
pnpm test
```
