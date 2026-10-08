#!/bin/sh
# HOME 은 매번 비어 있는 tmpfs 다. CLI 상태 디렉터리를 만들고, codex 인증 파일이 마운트되어 있으면
# 복사해서 쓴다. (토큰 갱신이 일어나도 호스트 파일은 바뀌지 않는다)
# /out 은 이번 요청의 산출물(생성 이미지)을 호스트로 넘기는 유일한 쓰기 경로다.
set -eu
mkdir -p "$HOME/.claude" "$HOME/.codex"
if [ -f /run/secrets/codex-auth.json ]; then
  cp /run/secrets/codex-auth.json "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
fi
# /out 이 마운트되어 있으면 codex 가 생성한 이미지(~/.codex/generated_images)를 그쪽에 남긴다.
if [ -d /out ]; then
  ln -sfn /out "$HOME/.codex/generated_images"
fi
exec "$@"
