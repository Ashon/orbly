#!/bin/sh
# allowed-domains.txt 의 도메인을 정확히 일치하는 정규식으로 바꿔 tinyproxy 필터를 만든다.
set -eu
src=/etc/egress/allowed-domains.txt
dst=/tmp/allowed-domains.ere
grep -v '^[[:space:]]*#' "$src" | tr -d ' \t\r' | grep -v '^$' \
  | sed -e 's/\./\\./g' -e 's/^/^/' -e 's/$/$/' > "$dst"
echo "egress allowlist:"
sed -e 's/^/  /' "$dst"
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
