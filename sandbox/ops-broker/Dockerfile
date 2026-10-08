# 운영 점검 중계(MCP). 빌드 컨텍스트는 이 디렉터리이고, 코드는 미리 묶은 번들 하나다. (pnpm bundle)
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
COPY dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
