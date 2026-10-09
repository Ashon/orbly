#!/bin/sh
# Usage: render <mermaid|dot|vega-lite|svg> <input file> <output PNG>
#        render resize <input image> <output PNG> <max long side px>
# The container runs without network, with a read-only root and tmpfs (/tmp).
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
# A single chart without a set size is drawn at a size that reads well in Slack.
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
    python3 - "$input" "$output" "${4:?max long side px is required}" <<'PY'
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
    echo "unsupported format: $format" >&2
    exit 2
    ;;
esac
