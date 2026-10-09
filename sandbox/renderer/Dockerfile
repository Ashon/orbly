# Diagram/chart rendering container. Renders mermaid, dot, vega-lite, and svg written by the model to PNG,
# and shrinks generated images before upload.
# The bot starts it per request as a disposable container without network (--network none).
FROM node:24-bookworm-slim

ARG MERMAID_CLI_VERSION
ARG VL_CONVERT_VERSION
ARG PILLOW_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates chromium graphviz librsvg2-bin fonts-noto-cjk python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# mermaid-cli uses the system chromium. (Skips puppeteer's browser download)
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
