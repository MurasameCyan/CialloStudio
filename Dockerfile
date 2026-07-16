# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22
ARG NGINX_VERSION=1.27-alpine

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS frontend-builder

WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
RUN npm run build

FROM nginx:${NGINX_VERSION}

RUN apk add --no-cache gettext curl

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --from=frontend-builder /src/dist /usr/share/nginx/html

ENV CIALLO_UPSTREAM=https://grokb.yuzu.gv.uy
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
