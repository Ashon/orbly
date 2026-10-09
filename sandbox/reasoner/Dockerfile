# Reasoner container for mention replies. Started fresh per request and removed when done.
# The bot applies runtime restrictions (read-only root, tmpfs, internal network, dropped privileges) with docker run options.
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
