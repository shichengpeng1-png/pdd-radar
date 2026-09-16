#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/shop-ledger-pro
DATA=/var/lib/shop-ledger-pro
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
[[ $(id -u) = 0 ]] || { echo 'Run as root'; exit 1; }
prepare() {
  command -v nginx >/dev/null || { echo 'Existing nginx required'; exit 1; }
  if ss -lntp | grep -q ':18761 '; then
    systemctl is-active --quiet shop-ledger-pro || { echo 'Port 18761 belongs to another service'; exit 1; }
  fi
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
  id shop-ledger-pro >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin shop-ledger-pro
  install -d -m 750 -o shop-ledger-pro -g shop-ledger-pro "$DATA"
  mkdir -p "$ROOT/releases" "$ROOT/backups"
  release="$ROOT/releases/$(date +%Y%m%d-%H%M%S)"
  mkdir "$release"
  cp -a "$HERE/server.py" "$HERE/public" "$release/"
  [[ -f "$release/public/vendor/lang/chi_sim.traineddata.gz" ]] || { echo 'Run vendor.py before deployment'; exit 1; }
  python3 -m venv "$release/venv"
  "$release/venv/bin/pip" install --disable-pip-version-check 'gunicorn==23.0.0'
  readlink -f "$ROOT/current" > "$ROOT/previous-release" || true
  ln -sfn "$release" "$ROOT/current.next"
  mv -Tf "$ROOT/current.next" "$ROOT/current"
  cat > /etc/systemd/system/shop-ledger-pro.service <<'EOF'
[Unit]
Description=Shop Ledger Pro
After=network.target
[Service]
User=shop-ledger-pro
Group=shop-ledger-pro
WorkingDirectory=/opt/shop-ledger-pro/current
Environment=LEDGER_DATA=/var/lib/shop-ledger-pro
Environment=TZ=Asia/Shanghai
ExecStart=/opt/shop-ledger-pro/current/venv/bin/gunicorn --workers 1 --threads 4 --bind 127.0.0.1:18761 --timeout 60 server:application
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/shop-ledger-pro
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/shop-ledger-pro-tick.service <<'EOF'
[Unit]
Description=Generate due ledger entries and daily backup
[Service]
Type=oneshot
User=shop-ledger-pro
Group=shop-ledger-pro
Environment=LEDGER_DATA=/var/lib/shop-ledger-pro
Environment=TZ=Asia/Shanghai
ExecStart=/opt/shop-ledger-pro/current/venv/bin/python /opt/shop-ledger-pro/current/server.py --tick
UMask=0077
EOF
  cat > /etc/systemd/system/shop-ledger-pro-tick.timer <<'EOF'
[Unit]
Description=Hourly ledger maintenance
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  echo 'Prepared. Set the website password, then run deploy.sh activate.'
}
activate() {
  runuser -u shop-ledger-pro -- env LEDGER_DATA="$DATA" "$ROOT/current/venv/bin/python" -c 'import sqlite3; c=sqlite3.connect("/var/lib/shop-ledger-pro/ledger.sqlite3"); assert c.execute("select v from settings where k=?",("password",)).fetchone(), "Set website password first"'
  cfg=/etc/nginx/conf.d/shop-ledger-8081.conf
  [[ -f "$cfg" ]] || { echo "Expected existing config $cfg not found; review nginx before changing it"; exit 1; }
  stamp=$(date +%Y%m%d-%H%M%S)
  cp -a "$cfg" "$ROOT/backups/nginx-$stamp.conf"
  systemctl enable --now shop-ledger-pro
  systemctl restart shop-ledger-pro
  for attempt in $(seq 1 20); do
    curl -fsS http://127.0.0.1:18761/api/health && break
    sleep 1
  done
  curl -fsS http://127.0.0.1:18761/api/health >/dev/null
  cat > "$cfg" <<'EOF'
server {
    listen 8081;
    server_name _;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:18761;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
EOF
  if ! nginx -t || ! systemctl reload nginx; then
    cp -a "$ROOT/backups/nginx-$stamp.conf" "$cfg"
    nginx -t && systemctl reload nginx
    echo 'Nginx configuration restored'; exit 1
  fi
  systemctl enable --now shop-ledger-pro-tick.timer
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 8081/tcp; fi
  curl -fsS http://127.0.0.1:8081/api/health
  echo 'Local verification passed. Public access still requires Alibaba instance firewall TCP 8081.'
}
case "${1:-prepare}" in
prepare) prepare ;;
password) runuser -u shop-ledger-pro -- env LEDGER_DATA="$DATA" "$ROOT/current/venv/bin/python" "$ROOT/current/server.py" --set-password ;;
activate) activate ;;
*) echo 'Usage: deploy.sh prepare|password|activate'; exit 1 ;;
esac
