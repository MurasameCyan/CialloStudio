# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22
ARG NGINX_VERSION=1.27-alpine

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS frontend-builder

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
RUN npm run build


FROM nginx:${NGINX_VERSION}

# 社区 API 用 Node；nginx 反代 /api/community
RUN apk add --no-cache gettext curl nodejs \
  && mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp \
  && mkdir -p /data /opt/ciallo

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
COPY server/community-api.mjs /opt/ciallo/community-api.mjs
RUN chmod +x /entrypoint.sh \
  && sed -i 's/\r$//' /entrypoint.sh

COPY --from=frontend-builder /src/dist /usr/share/nginx/html

ENV CIALLO_MASTER_USERNAME=admin \
    CIALLO_MASTER_PASSWORD= \
    CIALLO_DATA_DIR=/data \
    CIALLO_COMMUNITY_PORT=8090 \
    TZ=Asia/Shanghai

VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
