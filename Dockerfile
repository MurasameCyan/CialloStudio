# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22
ARG NGINX_VERSION=1.27-alpine

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS frontend-builder

# 构建时注入 git SHA（CI: --build-arg CIALLO_BUILD_ID=$GITHUB_SHA）
ARG CIALLO_BUILD_ID=
ARG CIALLO_TRACK_REF=beta
ARG CIALLO_GITHUB_REPO=MurasameCyan/CialloStudio
ENV CIALLO_BUILD_ID=${CIALLO_BUILD_ID} \
    CIALLO_TRACK_REF=${CIALLO_TRACK_REF} \
    CIALLO_GITHUB_REPO=${CIALLO_GITHUB_REPO}

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
# vite.config.ts 开发代理依赖 SSRF guard（tsc -b 会解析该 import）
COPY server/upstream-guard.mjs server/upstream-guard.d.mts ./server/
RUN npm run build


FROM nginx:${NGINX_VERSION}

ARG CIALLO_BUILD_ID=
ARG CIALLO_TRACK_REF=beta
ARG CIALLO_GITHUB_REPO=MurasameCyan/CialloStudio

# 社区 API 用 Node；nginx 反代 /api/community
RUN apk add --no-cache gettext curl nodejs \
  && mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp \
  && mkdir -p /data /opt/ciallo

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
COPY server/community-api.mjs /opt/ciallo/community-api.mjs
COPY server/upstream-guard.mjs /opt/ciallo/upstream-guard.mjs
COPY server/v1-proxy.mjs /opt/ciallo/v1-proxy.mjs
COPY server/task-queue.mjs /opt/ciallo/task-queue.mjs
RUN chmod +x /entrypoint.sh \
  && sed -i 's/\r$//' /entrypoint.sh \
  && printf '%s' "${CIALLO_BUILD_ID}" > /opt/ciallo/BUILD_ID

COPY --from=frontend-builder /src/dist /usr/share/nginx/html

ENV CIALLO_MASTER_USERNAME=admin \
    CIALLO_MASTER_PASSWORD= \
    CIALLO_DATA_DIR=/data \
    CIALLO_COMMUNITY_PORT=8090 \
    CIALLO_BUILD_ID=${CIALLO_BUILD_ID} \
    CIALLO_TRACK_REF=${CIALLO_TRACK_REF} \
    CIALLO_GITHUB_REPO=${CIALLO_GITHUB_REPO} \
    TZ=Asia/Shanghai

VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
