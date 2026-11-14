#!/usr/bin/env bash
# First installation on a single-purpose Ubuntu server. No private bytes are published.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_NAME="${1:-}"
if [[ -z "$SITE_NAME" || ! "$SITE_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]]; then
  echo '用法：bash scripts/deploy-mobile.sh 服务器公网IPv4或域名'
  exit 1
fi
if [[ "$SITE_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SITE_NAME="${SITE_NAME}.sslip.io"
fi
if [[ "$(id -u)" == 0 ]]; then
  echo '请使用拥有 sudo 权限的普通用户（例如 ubuntu）运行，不要直接用 root。'
  exit 1
fi
NODE_BIN="$(command -v node)"
"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("需要 Node.js 24+")'
if command -v caddy >/dev/null 2>&1 || [[ -e /etc/caddy/Caddyfile ]]; then
  echo '检测到已有 Caddy。为保留现有网站，本安装器未更改配置。请按 docs/MOBILE-DEPLOY.md 的手动配置步骤合并。'
  exit 1
fi
if ss -ltnH | awk '{print $4}' | grep -Eq ':(80|443)$'; then
  echo '80 或 443 已被使用。请按 docs/MOBILE-DEPLOY.md 将衣橱加入现有 HTTPS 代理。'
  exit 1
fi
LIBRARY_DIR="$(realpath -m "${YIXU_DATA_DIR:-$HOME/apps/yixu/private-data}")"
OLD_APP_DIR="${YIXU_OLD_APP:-$HOME/apps/yixu}"
CONTROL_DIR="$LIBRARY_DIR/mobile-control"
mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
cd "$APP_DIR"
npm ci
npm test
npm run check
if [[ -f "$LIBRARY_DIR/wardrobe.sqlite" ]]; then
  "$NODE_BIN" scripts/check.mjs --data-dir "$LIBRARY_DIR"
  INSTALL_BACKUP="$CONTROL_DIR/install-backups/$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  YIXU_DATA_DIR="$LIBRARY_DIR" "$NODE_BIN" scripts/backup-private.mjs "$INSTALL_BACKUP"
fi
printf '衣橱网址：https://%s\n' "$SITE_NAME"
IFS= read -r -s -p '设置衣橱密码（至少 12 个字符，输入时不显示）：' MOBILE_PASSWORD
printf '\n'
IFS= read -r -s -p '再输入一次密码：' MOBILE_PASSWORD_CONFIRM
printf '\n'
if [[ "$MOBILE_PASSWORD" != "$MOBILE_PASSWORD_CONFIRM" ]]; then
  unset MOBILE_PASSWORD MOBILE_PASSWORD_CONFIRM
  echo '两次密码不同，未更改运行中的衣橱。'
  exit 1
fi
printf '%s' "$MOBILE_PASSWORD" | YIXU_DATA_DIR="$LIBRARY_DIR" YIXU_MOBILE_CONTROL="$CONTROL_DIR" "$NODE_BIN" scripts/mobile-setup.mjs "https://$SITE_NAME"
unset MOBILE_PASSWORD MOBILE_PASSWORD_CONFIRM
sudo apt-get update
sudo apt-get install -y caddy
# Only the newly installed default Caddy configuration is replaced.
sudo systemctl stop caddy
SETUP_DIR="$(mktemp -d)"
trap 'rm -rf "$SETUP_DIR"' EXIT
cat > "$SETUP_DIR/yixu-mobile.service" <<UNIT
[Unit]
Description=Yixu authenticated mobile wardrobe
After=network.target
[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$APP_DIR
Environment="YIXU_DATA_DIR=$LIBRARY_DIR"
Environment="YIXU_MOBILE_CONTROL=$CONTROL_DIR"
ExecStart=$NODE_BIN $APP_DIR/scripts/mobile-server.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$LIBRARY_DIR
TimeoutStopSec=120
[Install]
WantedBy=multi-user.target
UNIT
cat > "$SETUP_DIR/Caddyfile" <<CADDY
$SITE_NAME {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4185 {
        header_up X-Real-IP {remote_host}
    }
}
CADDY
sudo caddy validate --config "$SETUP_DIR/Caddyfile" --adapter caddyfile
sudo install -m 644 "$SETUP_DIR/yixu-mobile.service" /etc/systemd/system/yixu-mobile.service
sudo install -m 644 "$SETUP_DIR/Caddyfile" /etc/caddy/Caddyfile
# Stop only the previously identified checkout using its ownership-aware launcher.
if [[ -f "$OLD_APP_DIR/scripts/local.mjs" ]]; then
  (cd "$OLD_APP_DIR" && YIXU_DATA_DIR="$LIBRARY_DIR" "$NODE_BIN" scripts/local.mjs stop)
fi
sudo systemctl daemon-reload
sudo systemctl enable --now yixu-mobile
sudo systemctl enable --now caddy
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q '^Status: active'; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
fi
printf '\n部署服务已启动。请在云控制台安全组放行 TCP 80 和 443，然后用 Safari 打开：\nhttps://%s/manage\n' "$SITE_NAME"
printf '首次证书申请可能需要等待，请用以下命令查看：\nsudo journalctl -u caddy -n 40 --no-pager\nsudo systemctl status yixu-mobile --no-pager\n'
