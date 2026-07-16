#!/bin/sh
set -eu

# CIALLO_UPSTREAM 例：
#   https://grokb.yuzu.gv.uy
#   http://host.docker.internal:8000
UPSTREAM="${CIALLO_UPSTREAM:-https://grokb.yuzu.gv.uy}"

# 去掉末尾斜杠与可选 /v1
UPSTREAM="${UPSTREAM%/}"
case "$UPSTREAM" in
  */v1) UPSTREAM="${UPSTREAM%/v1}" ;;
esac

SCHEME="https"
HOSTPORT=""

case "$UPSTREAM" in
  https://*)
    SCHEME="https"
    HOSTPORT="${UPSTREAM#https://}"
    ;;
  http://*)
    SCHEME="http"
    HOSTPORT="${UPSTREAM#http://}"
    ;;
  *)
    echo "CIALLO_UPSTREAM must start with http:// or https://, got: $UPSTREAM" >&2
    exit 1
    ;;
esac

# nginx upstream 不写 scheme；proxy_pass 再拼 scheme
export CIALLO_UPSTREAM_SCHEME="$SCHEME"
export CIALLO_UPSTREAM_HOST="$HOSTPORT"

envsubst '${CIALLO_UPSTREAM_SCHEME} ${CIALLO_UPSTREAM_HOST}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
