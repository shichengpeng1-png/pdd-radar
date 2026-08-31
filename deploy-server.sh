#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/shichengpeng1-png/pdd-radar.git"
APP_DIR="/opt/pdd-radar-v2-full"
BACKUP_DIR="/opt/pdd-radar-v2-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  tar -C "$APP_DIR" -czf "$BACKUP_DIR/data-env-$STAMP.tar.gz" data .env 2>/dev/null || true
fi

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  temp_dir="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$temp_dir/app"
  mkdir -p "$APP_DIR"
  cp -a "$temp_dir/app/." "$APP_DIR/"
  rm -rf "$temp_dir"
fi

latest_backup="$(ls -t "$BACKUP_DIR"/data-env-*.tar.gz 2>/dev/null | head -n 1 || true)"
if [ -n "$latest_backup" ]; then
  tar -C "$APP_DIR" -xzf "$latest_backup" || true
fi

cd "$APP_DIR"
npm install --omit=dev
install -m 644 pdd-radar-v2.service /etc/systemd/system/pdd-radar-v2.service
systemctl daemon-reload
systemctl enable --now pdd-radar-v2.service
systemctl restart pdd-radar-v2.service
systemctl --no-pager --full status pdd-radar-v2.service

