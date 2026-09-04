#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/pdd-radar-v2-full"
BACKUP_DIR="/opt/pdd-radar-v2-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_ARCHIVE="${1:?请传入发布压缩包路径}"

if [ ! -f "$RELEASE_ARCHIVE" ]; then
  echo "发布压缩包不存在: $RELEASE_ARCHIVE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  tar -C "$APP_DIR" -czf "$BACKUP_DIR/data-env-$STAMP.tar.gz" data .env 2>/dev/null || true
fi

# 仅保留最近 3 份发布前备份，避免截图备份持续累积占满服务器磁盘。
backup_count=0
for backup_file in $(ls -1t "$BACKUP_DIR"/data-env-*.tar.gz 2>/dev/null || true); do
  backup_count=$((backup_count + 1))
  if [ "$backup_count" -gt 3 ]; then
    rm -f -- "$backup_file"
  fi
done

# 代码由 GitHub Actions 通过 SSH 传入，服务器无需访问 GitHub。
mkdir -p "$APP_DIR"
tar -xzf "$RELEASE_ARCHIVE" -C "$APP_DIR"
rm -f "$RELEASE_ARCHIVE"

latest_backup="$(ls -t "$BACKUP_DIR"/data-env-*.tar.gz 2>/dev/null | head -n 1 || true)"
if [ -n "$latest_backup" ]; then
  tar -C "$APP_DIR" -xzf "$latest_backup" || true
fi

cd "$APP_DIR"
npm install --omit=dev

# OCR 使用简体中文语言包。部分服务器仅预装了 tesseract 主程序，
# 会导致每次截图识别都以进程错误结束。
if ! /usr/bin/tesseract --list-langs 2>/dev/null | grep -qx 'chi_sim'; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tesseract-ocr-chi-sim
fi

install -m 644 pdd-radar-v2.service /etc/systemd/system/pdd-radar-v2.service
systemctl daemon-reload
systemctl enable --now pdd-radar-v2.service
systemctl restart pdd-radar-v2.service
systemctl --no-pager --full status pdd-radar-v2.service

