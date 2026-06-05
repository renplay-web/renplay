#!/bin/sh
set -e

GAMES_DIR="${GAMES_DIR:-/games}"
SAVES_DIR="${SAVES_DIR:-/data/saves}"
DATA_DIR="${DATA_DIR:-/data}"

mkdir -p "$GAMES_DIR" "$SAVES_DIR" "$DATA_DIR" /tmp/nginx

export GAMES_DIR
export SAVES_DIR
export DATA_DIR

envsubst '${GAMES_DIR} ${DATA_DIR}' < /etc/nginx/nginx.conf.template > /tmp/nginx/nginx.conf

node /app/server/dist/index.js &
SERVER_PID=$!

READY=0
for i in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited before becoming ready" >&2
    exit 1
  fi
  if wget -q -O /dev/null http://127.0.0.1:3000/api/health 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.25
done

if [ "$READY" -eq 0 ]; then
  echo "server failed to become ready after 10s" >&2
  kill "$SERVER_PID" 2>/dev/null
  exit 1
fi

trap 'kill $SERVER_PID; exit' INT TERM

echo "Starting nginx..."
nginx -c /tmp/nginx/nginx.conf -g 'daemon off;'
