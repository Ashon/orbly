#!/bin/sh
# 사용법: render <mermaid|dot|vega-lite|svg> <입력 파일> <출력 PNG>
#         render resize <입력 이미지> <출력 PNG> <긴 변 최대 px>
# 컨테이너는 네트워크 없이, 읽기 전용 루트와 tmpfs(/tmp)로 실행된다.
set -eu
format="$1"
input="$2"
output="$3"
mkdir -p "$HOME"

case "$format" in
  mermaid)
    mmdc --quiet -i "$input" -o "$output" -b white -s 2 \
      -p /etc/renderer/puppeteer.json -c /etc/renderer/mermaid.json
    ;;
  dot)
    dot -Tpng -Gdpi=150 -Gfontname="Noto Sans CJK KR" -Nfontname="Noto Sans CJK KR" \
      -Efontname="Noto Sans CJK KR" -o "$output" "$input"
    ;;
  vega-lite)
    python3 - "$input" "$output" <<'PY'
import sys
import vl_convert as vlc
vlc.register_font_directory("/usr/share/fonts")
import json
spec = json.loads(open(sys.argv[1], encoding="utf-8").read())
# 크기를 지정하지 않은 단일 차트는 Slack 에서 읽기 좋은 크기로 그린다.
if "mark" in spec:
    spec.setdefault("width", 520)
    spec.setdefault("height", 260)
png = vlc.vegalite_to_png(json.dumps(spec), scale=2)
open(sys.argv[2], "wb").write(png)
PY
    ;;
  svg)
    rsvg-convert --format png --zoom 2 --background-color white --output "$output" "$input"
    ;;
  resize)
    python3 - "$input" "$output" "${4:?긴 변 최대 px 가 필요합니다}" <<'PY'
import sys
from PIL import Image
src, dst, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
with Image.open(src) as img:
    img.thumbnail((limit, limit), Image.Resampling.LANCZOS)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    img.save(dst, "PNG", optimize=True)
PY
    ;;
  *)
    echo "지원하지 않는 형식: $format" >&2
    exit 2
    ;;
esac
