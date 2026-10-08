# 멘션 답변용 추론 컨테이너. 요청마다 새로 띄우고 끝나면 지운다.
# 실행 제약(읽기 전용 루트, tmpfs, 내부 네트워크, 권한 제거)은 봇이 docker run 옵션으로 건다.
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep poppler-utils \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 0755 /usr/local/bin/sandbox-entrypoint \
  && mkdir -p /work && chown node:node /work

USER node
ENV HOME=/home/node \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
