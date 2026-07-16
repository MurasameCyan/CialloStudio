#!/bin/sh
set -eu

# CIALLO_UPSTREAM 例：
#   https://your-grok2api.example.com
#   https://your-grok2api.example.com/v1
#   http://host.docker.internal:8000
UPSTREAM="${CIALLO_UPSTREAM:-https://your-grok2api.example.com}"
UPSTREAM="$(printf '%s' "$UPSTREAM" | tr -d '\r' | sed 's/[[:space:]]//g')"

# 去掉末尾斜杠
while [ "${UPSTREAM%/}" != "$UPSTREAM" ]; do
  UPSTREAM="${UPSTREAM%/}"
done

# 去掉末尾 /v1（可重复）
case "$UPSTREAM" in
  */v1) UPSTREAM="${UPSTREAM%/v1}" ;;
esac
while [ "${UPSTREAM%/}" != "$UPSTREAM" ]; do
  UPSTREAM="${UPSTREAM%/}"
done

case "$UPSTREAM" in
  https://*|http://*)
    ;;
  *)
    echo "CIALLO_UPSTREAM must start with http:// or https://, got: ${CIALLO_UPSTREAM:-}" >&2
    exit 1
    ;;
esac

export CIALLO_UPSTREAM_ORIGIN="$UPSTREAM"

echo "[ciallo] upstream origin: $CIALLO_UPSTREAM_ORIGIN"

# 只替换我们声明的变量，避免误伤 nginx 的 $uri 等
envsubst '${CIALLO_UPSTREAM_ORIGIN}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

# 启动前做一次语法检查，失败直接退出
nginx -t

exec nginx -g 'daemon off;'
