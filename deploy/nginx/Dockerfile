FROM node:23-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build

COPY selector/package.json selector/package-lock.json* /build/selector/
RUN cd selector && npm ci

COPY selector/ /build/selector/
RUN cd selector && npm run build

COPY save-sync/package.json save-sync/package-lock.json* /build/save-sync/
RUN cd save-sync && npm ci

COPY save-sync/ /build/save-sync/
RUN cd save-sync && npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache nodejs gettext

EXPOSE 8080

COPY --from=builder /build/selector/dist /usr/share/nginx/html/selector
COPY --from=builder /build/save-sync/dist /app/save-sync/dist
COPY --from=builder /build/save-sync/node_modules /app/save-sync/node_modules

COPY deploy/nginx/nginx.conf.template /etc/nginx/nginx.conf.template
COPY deploy/nginx/sync-client.js /usr/share/nginx/html/selector/sync-client.js
COPY deploy/nginx/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
