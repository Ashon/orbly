#!/bin/sh
# Turns the domains in allowed-domains.txt into exact-match regexes to build the tinyproxy filter.
set -eu
src=/etc/egress/allowed-domains.txt
dst=/tmp/allowed-domains.ere
grep -v '^[[:space:]]*#' "$src" | tr -d ' \t\r' | grep -v '^$' \
  | sed -e 's/\./\\./g' -e 's/^/^/' -e 's/$/$/' > "$dst"
echo "egress allowlist:"
sed -e 's/^/  /' "$dst"
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
