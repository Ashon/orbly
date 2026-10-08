# 운영 점검 중계(MCP). 저장소 루트를 빌드 컨텍스트로 쓴다. (sandbox/compose.yaml)
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

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
# 에이전트 작업 공간(미러, worktree) 볼륨. 볼륨 첫 마운트 시 이 소유권을 이어받는다.
RUN mkdir -p /work && chown node:node /work
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/broker/server.js"]
