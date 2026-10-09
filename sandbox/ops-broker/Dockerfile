# Ops check relay (MCP). The build context is this directory, and the code is a single prebuilt bundle. (pnpm bundle)
FROM node:24-bookworm-slim
ARG KUBECTL_VERSION=v1.37.0
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates curl ripgrep git \
  && curl -fsSL -o /usr/local/bin/kubectl \
    "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
  && chmod 0755 /usr/local/bin/kubectl \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# Agent workspace (mirrors, worktrees) volume. The volume inherits this ownership on first mount.
RUN mkdir -p /work && chown node:node /work
WORKDIR /app
COPY dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
