# Pacenote team hub (docs/team-hub.md). The build context is this directory, and the code is a single prebuilt
# bundle (pnpm bundle, or pnpm hub:image to bundle and build in one step).
FROM node:24-bookworm-slim
# Paired desktops (desktops.json). The volume inherits this ownership on first mount.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY dist/hub.mjs ./hub.mjs
USER node
ENV HUB_DATA_DIR=/data HUB_PORT=8790
EXPOSE 8790
CMD ["node", "hub.mjs"]
