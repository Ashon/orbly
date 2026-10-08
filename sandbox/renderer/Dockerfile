# 다이어그램/차트 렌더링 컨테이너. 모델이 쓴 mermaid, dot, vega-lite, svg 를 PNG 로 그리고,
# 생성 이미지는 업로드 전에 크기를 줄인다.
# 봇이 요청마다 네트워크 없이(--network none) 일회용으로 띄운다.
FROM node:24-bookworm-slim

ARG MERMAID_CLI_VERSION
ARG VL_CONVERT_VERSION
ARG PILLOW_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates chromium graphviz librsvg2-bin fonts-noto-cjk python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# mermaid-cli 는 시스템 chromium 을 쓴다. (puppeteer 의 브라우저 다운로드 생략)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN npm install -g "@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}" && npm cache clean --force
RUN pip3 install --no-cache-dir --break-system-packages \
    "vl-convert-python==${VL_CONVERT_VERSION}" "pillow==${PILLOW_VERSION}"

COPY puppeteer.json /etc/renderer/puppeteer.json
COPY mermaid.json /etc/renderer/mermaid.json
COPY render.sh /usr/local/bin/render
RUN chmod 0755 /usr/local/bin/render

USER node
ENV HOME=/tmp/home
ENTRYPOINT ["/usr/local/bin/render"]
