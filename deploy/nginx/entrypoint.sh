#!/bin/sh
set -e

GAMES_DIR="${GAMES_DIR:-/games}"
SAVES_DIR="${SAVES_DIR:-/data/saves}"
DATA_DIR="${DATA_DIR:-/data}"

mkdir -p "$GAMES_DIR" "$SAVES_DIR" "$DATA_DIR"

export GAMES_DIR
export SAVES_DIR
export DATA_DIR

envsubst '${GAMES_DIR} ${DATA_DIR}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

node /app/save-sync/dist/index.js &
SAVE_SYNC_PID=$!

sleep 0.5
if ! kill -0 "$SAVE_SYNC_PID" 2>/dev/null; then
  echo "save-sync failed to start" >&2
  exit 1
fi

trap 'kill $SAVE_SYNC_PID; exit' INT TERM

echo "Starting nginx..."
nginx -g 'daemon off;'
