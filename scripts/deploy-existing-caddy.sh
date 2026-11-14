#!/usr/bin/env bash
# Existing-Caddy cutover for the owner's original yixu.service deployment.
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_IP="${1:-}"
NODE_BIN="$(command -v node)"
"$NODE_BIN" --input-type=module - "$PUBLIC_IP" <<'JS'
import {isIPv4} from 'node:net';
if(!isIPv4(process.argv[2]))throw Error('请提供正确的服务器公网 IPv4');
if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24+');
JS
if [[ "$(id -u)" == 0 ]]; then
  echo '请使用 ubuntu 等有 sudo 权限的普通用户运行。'
  exit 1
fi
for TOOL in caddy npm ip curl python3 ss; do command -v "$TOOL" >/dev/null; done
LIBRARY_DIR="$(realpath -m "${YIXU_DATA_DIR:-$HOME/apps/yixu/private-data}")"
CONTROL_DIR="$LIBRARY_DIR/mobile-control"
SITE_NAME="$PUBLIC_IP.sslip.io"
BIND_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')"
"$NODE_BIN" --input-type=module - "$BIND_IP" <<'JS'
import {isIPv4} from 'node:net';
if(!isIPv4(process.argv[2]))throw Error('无法确定服务器网卡 IPv4，未修改配置');
JS
if [[ ! -f "$LIBRARY_DIR/wardrobe.sqlite" ]]; then
  echo "没有找到现有数据库：$LIBRARY_DIR/wardrobe.sqlite。未创建空衣橱，请先核对 YIXU_DATA_DIR。"
  exit 1
fi
if [[ -e /etc/systemd/system/yixu-mobile.service ]]; then
  echo '已存在 yixu-mobile.service。此脚本用于首次切换，请先查看 sudo systemctl status yixu-mobile。'
  exit 1
fi
if ss -ltnH | awk '{print $4}' | grep -Eq ':(4185|4186)$'; then
  echo '4185 或 4186 已被占用，未修改服务。'
  exit 1
fi
sudo -v
sudo systemctl cat yixu.service >/dev/null
SETUP_DIR="$(mktemp -d)"
trap 'rm -rf "$SETUP_DIR"' EXIT
# Inspect the effective old configuration; never silently replace other sites.
sudo caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$SETUP_DIR/old-caddy.json"
python3 - "$SETUP_DIR/old-caddy.json" <<'PY'
import json,sys
config=json.load(open(sys.argv[1]))
servers=config.get('apps',{}).get('http',{}).get('servers',{})
listeners=[a for s in servers.values() for a in s.get('listen',[])]
upstreams=[]
def walk(value):
    if isinstance(value,dict):
        if value.get('handler')=='reverse_proxy':
            upstreams.extend(x.get('dial') for x in value.get('upstreams',[]))
        for v in value.values():walk(v)
    elif isinstance(value,list):
        for v in value:walk(v)
walk(config)
if listeners!=['127.0.0.1:4184'] or upstreams!=['127.0.0.1:4183']:
    raise SystemExit('现有 Caddy 配置与已确认的旧衣橱转发不一致，未覆盖；请重新检查配置。')
PY
# Confirm that the running old service is using the exact intended library.
OLD_PID="$(sudo systemctl show yixu.service -p MainPID --value)"
if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]]; then
  sudo python3 - "$OLD_PID" "$LIBRARY_DIR" <<'PY'
import os,sys
pid,directory=sys.argv[1:]
env=dict(x.split(b'=',1) for x in open('/proc/'+pid+'/environ','rb').read().split(b'\0') if b'=' in x)
cwd=os.path.realpath('/proc/'+pid+'/cwd')
actual=os.path.realpath(os.fsdecode(env.get(b'YIXU_DATA_DIR',os.fsencode(cwd+'/private-data'))))
if actual!=os.path.realpath(directory):raise SystemExit('旧服务的数据目录与安装目标不一致，未修改服务。')
PY
fi
cd "$APP_DIR"
npm ci
npm test
npm run check
"$NODE_BIN" scripts/check.mjs --data-dir "$LIBRARY_DIR"
mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
BACKUP_DIR="$CONTROL_DIR/install-backups/$STAMP"
YIXU_DATA_DIR="$LIBRARY_DIR" "$NODE_BIN" scripts/backup-private.mjs "$BACKUP_DIR"
CADDY_BACKUP="/etc/caddy/Caddyfile.before-mobile-$STAMP"
sudo cp -a /etc/caddy/Caddyfile "$CADDY_BACKUP"
printf '新衣橱地址：https://%s/manage\n' "$SITE_NAME"
IFS= read -r -s -p '设置衣橱密码（至少12位，输入不显示）：' MOBILE_PASSWORD
printf '\n'
IFS= read -r -s -p '再输入一次：' MOBILE_PASSWORD_CONFIRM
printf '\n'
if [[ "$MOBILE_PASSWORD" != "$MOBILE_PASSWORD_CONFIRM" ]]; then
  unset MOBILE_PASSWORD MOBILE_PASSWORD_CONFIRM
  echo '两次密码不同，未切换服务。'
  exit 1
fi
printf '%s' "$MOBILE_PASSWORD" | YIXU_DATA_DIR="$LIBRARY_DIR" YIXU_MOBILE_CONTROL="$CONTROL_DIR" "$NODE_BIN" scripts/mobile-setup.mjs "https://$SITE_NAME"
unset MOBILE_PASSWORD MOBILE_PASSWORD_CONFIRM
cat > "$SETUP_DIR/Caddyfile" <<CADDY
$SITE_NAME {
    # Bind the cloud-facing interface only; leave Tailscale's 443 listener intact.
    bind $BIND_IP
    encode zstd gzip
    reverse_proxy 127.0.0.1:4185 {
        header_up X-Real-IP {remote_host}
    }
}
CADDY
sudo caddy validate --config "$SETUP_DIR/Caddyfile" --adapter caddyfile
cat > "$SETUP_DIR/yixu-mobile.service" <<UNIT
[Unit]
Description=Yixu authenticated mobile wardrobe
After=network.target
Conflicts=yixu.service
[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$APP_DIR
Environment="YIXU_DATA_DIR=$LIBRARY_DIR"
Environment="YIXU_MOBILE_CONTROL=$CONTROL_DIR"
Environment="YIXU_BACKEND_PORT=4186"
Environment="YIXU_MOBILE_PORT=4185"
ExecStart="$NODE_BIN" "$APP_DIR/scripts/mobile-server.mjs"
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$LIBRARY_DIR"
TimeoutStopSec=120
[Install]
WantedBy=multi-user.target
UNIT
OLD_ACTIVE="$(sudo systemctl is-active yixu.service || true)"
OLD_ENABLED="$(sudo systemctl is-enabled yixu.service || true)"
CADDY_ACTIVE="$(sudo systemctl is-active caddy || true)"
CUTOVER=0
rollback() {
  local result=$?
  trap - ERR
  if [[ "$CUTOVER" == 1 ]]; then
    echo '切换未完成，正在恢复旧配置与原服务状态。'
    sudo systemctl disable --now yixu-mobile.service || true
    sudo cp -a "$CADDY_BACKUP" /etc/caddy/Caddyfile || true
    sudo rm -f /etc/systemd/system/yixu-mobile.service
    sudo systemctl daemon-reload || true
    if [[ "$OLD_ENABLED" == enabled ]]; then sudo systemctl enable yixu.service || true; fi
    if [[ "$OLD_ACTIVE" == active ]]; then sudo systemctl start yixu.service || true; fi
    if [[ "$CADDY_ACTIVE" == active ]]; then sudo systemctl reload-or-restart caddy || true; else sudo systemctl stop caddy || true; fi
    printf '数据备份保留在：%s\nCaddy 备份：%s\n' "$BACKUP_DIR" "$CADDY_BACKUP"
  fi
  exit "$result"
}
trap rollback ERR
CUTOVER=1
sudo systemctl disable --now yixu.service
sudo install -m 644 "$SETUP_DIR/yixu-mobile.service" /etc/systemd/system/yixu-mobile.service
sudo systemctl daemon-reload
sudo systemctl enable --now yixu-mobile.service
READY=0
for ((i=0;i<30;i++)); do
  if curl --fail --silent --max-time 2 -H "Host: $SITE_NAME" http://127.0.0.1:4185/login -o "$SETUP_DIR/login.html"; then READY=1; break; fi
  sleep 1
done
if [[ "$READY" != 1 ]]; then
  sudo journalctl -u yixu-mobile -n 40 --no-pager
  false
fi
sudo install -m 644 "$SETUP_DIR/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl reload-or-restart caddy
CUTOVER=0
trap - ERR
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q '^Status: active'; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
fi
printf '\n手机服务与 Caddy 已切换。云控制台安全组需允许 TCP 80、443。\nSafari 地址：https://%s/manage\n' "$SITE_NAME"
printf '完整数据备份：%s\nCaddy 配置备份：%s\n' "$BACKUP_DIR" "$CADDY_BACKUP"
printf 'HTTPS 证书仍需签发；若暂时打不开，请查看：\nsudo journalctl -u caddy -n 60 --no-pager\n'
