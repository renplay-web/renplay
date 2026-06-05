FROM node:22-alpine AS builder

RUN apk add --no-cache make g++

WORKDIR /build

COPY selector/package.json selector/package-lock.json* /build/selector/
RUN cd selector && npm ci

COPY selector/ /build/selector/
RUN cd selector && npm run build

COPY server/package.json server/package-lock.json* /build/server/
RUN cd server && npm ci

COPY server/ /build/server/
RUN cd server && npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache nodejs gettext && \
    mkdir -p /tmp/nginx && \
    adduser -D -u 1000 renplay && \
    chmod 777 /tmp/nginx

EXPOSE 8080

COPY --from=builder /build/selector/dist /usr/share/nginx/html/selector
COPY --from=builder /build/server/dist /app/server/dist
COPY --from=builder /build/server/node_modules /app/server/node_modules

COPY deploy/nginx/nginx.conf.template /etc/nginx/nginx.conf.template
COPY deploy/nginx/sync-client.js /usr/share/nginx/html/selector/sync-client.js
COPY deploy/nginx/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
