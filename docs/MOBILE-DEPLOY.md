# iPhone 登录、上传和管理版

此扩展将现有只读衣橱放在有会话登录保护的 HTTPS 网关之后。未登录不能读取衣橱数据和照片。原服务仍只监听回环地址，网关不会向公网开放底层任意写入 API。

网页 `/manage` 支持：密码登录与退出、衣物照片上传、名称/类别/颜色/季节编辑、准备丢弃与恢复在用、已有衣物组合与搭配照片保存、搭配编辑和移除、完整备份下载、备份校验预览和确认恢复。不是多人账户系统，不包含自动抠图或 AI 生成。

## 无域名的 Ubuntu 首次安装

安装包应解压为新目录，例如 `/home/ubuntu/apps/yixu-mobile`。不要覆盖原项目目录。可以在 iPhone 下载本安装包到「文件」，再通过支持 SFTP 的 SSH App 上传至服务器。上传包时不需要传数据库或私人照片。

下例对应旧项目 `/home/ubuntu/apps/yixu`，旧数据默认 `/home/ubuntu/apps/yixu/private-data`。若实际设置过 `YIXU_DATA_DIR`，务必改成实际数据路径。不要把嵌套的新 clone 目录误当作当前数据目录。

在服务器终端执行（包名以下载文件为准）：

```bash
mkdir -p /home/ubuntu/apps/yixu-mobile
unzip /home/ubuntu/apps/yixu-mobile.zip -d /home/ubuntu/apps/yixu-mobile
cd /home/ubuntu/apps/yixu-mobile
YIXU_DATA_DIR=/home/ubuntu/apps/yixu/private-data bash scripts/deploy-mobile.sh 你的服务器公网IPv4
```

输入你自己的密码两次；至少 12 个字符，输入不显示。不要把密码发到聊天或写到 shell 历史中。

安装器先安装锁定的依赖、运行测试、检查当前数据库、建立完整备份，再配置独立的 `yixu-mobile` systemd 服务。它只通过旧项目启动器停止旧的 4183 衣橱，不会删除旧项目或私人数据。新服务开机自动启动。需 sudo；安装器会安装 Ubuntu 的 Caddy 软件包，因此仅用于尚无 HTTPS 代理的服务器。若发现已有代理或 80/443 占用，它会退出并保留原网站。

安装器使用 `你的公网IP.sslip.io` 免费解析域名。无需购买域名；该公共解析服务的可用性由其运营方决定，也可换成你拥有的域名。证书由 Caddy 自动申请和续期。服务器公网 IP 应稳定。

在云服务商控制台的**安全组/防火墙**中允许公网入站 TCP **80、443**。无需开放 4183、4184、4185。若有 UFW，安装器会在已启用的 UFW 中放行 80/443。

随后 iPhone Safari 打开：

```text
https://你的公网IP.sslip.io/manage
```

证书签发后应显示正常 HTTPS，不要忽略证书错误。Safari「分享 → 添加到主屏幕」可以建立快捷入口；这不是离线应用。

若免费域名无法解析或证书申请受限，查看 Caddy 日志并改用自有域名或另一个你控制的解析方式，不要改为明文 HTTP 发送密码。

## 已有 Caddy/Nginx：手动部署

Node.js 24+；`npm ci` 安装新增的 `sharp` 图片解码依赖。原来的 `npm start` 仍保持本机版行为；手机版用 `npm run mobile:start`。

先明确旧数据目录，运行 `node scripts/backup-private.mjs` 完整备份。在关闭旧服务前，检查 `/proc/<旧PID>/cwd` 与旧项目启动器是否对应。

在新源码目录设置（同一会话内）：

```bash
export YIXU_DATA_DIR=/home/ubuntu/apps/yixu/private-data
export YIXU_MOBILE_CONTROL="$YIXU_DATA_DIR/mobile-control"
IFS= read -r -s -p '设置至少12位密码：' MOBILE_PASSWORD
printf '\n'
printf '%s' "$MOBILE_PASSWORD" | node scripts/mobile-setup.mjs https://你的域名
unset MOBILE_PASSWORD
```

配置生成在 `$YIXU_MOBILE_CONTROL/config.json`，权限 600，包含随机盐和 scrypt 密码哈希。绝不提交此目录。修改密码后需要重启 mobile 服务，旧会话失效。

先停止原本机服务或其 systemd 单元，再启动 mobile 服务。**不要让旧服务或 CLI 与手机版同时对同一数据库写入。** 网关会创建自己的内部服务，默认 4184；对外代理入口为 4185，二者均只绑定 `127.0.0.1`。

```bash
npm run mobile:start
```

持久运行请参考 `scripts/deploy-mobile.sh` 中的 systemd 模板。`WorkingDirectory` 使用新源码目录；设置 `User=ubuntu`、绝对路径 `ExecStart`、明确的数据与控制目录；`ProtectSystem` 等权限也须包含实际数据目录。不要使用 `npm start` 作为手机服务的开机启动命令。

已有 Caddy 追加一个站点（替换域名）：

```caddyfile
wardrobe.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4185 {
        header_up X-Real-IP {remote_host}
    }
}
```

已有 Nginx，在配置了有效证书的 HTTPS server 中代理到 **4185**，保留 Host 与 Origin，覆盖来自客户端的 X-Real-IP：

```nginx
client_max_body_size 300m;
location / {
    proxy_pass http://127.0.0.1:4185;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
}
```

不要把公网代理直接指向旧服务 4183 或内部服务 4184。`mobile-setup.mjs` 指定的 HTTPS origin 必须与最终浏览器地址完全一致（包括非默认端口）。

## 照片与备份

选择 iPhone 相册照片；支持 JPEG、PNG、WebP 静态图，单张最大 10 MB、2500 万像素。HEIC 需先转换为 JPEG；可以用 iPhone「快捷指令」的「转换图像」操作。原始上传字节会作为已登记图片保留，随完整备份保存。展示图只纠正 EXIF 方向、缩小至 1600 像素并重新编码 PNG，移除展示图中的 EXIF，不进行抠图或重建。上传照片原件可能保留原有元数据，仅登录后可访问。

`processingMethod: original-photo` 准确标明来源；不会伪造“去背景”审核。未知材质、版型、图案不自动推断。类别和颜色由使用者填写。重复来源不会重复添加衣物；多个单品在同一张照片中的细分录入仍使用原 CLI 流程。

点击备份会下载 `.yixu.gz` 文件，包含一致的 SQLite 快照、全部已登记图片和每个文件的 SHA-256。手机备份支持原始数据库与媒体合计最多 150 MB；超过时使用原命令行完整备份工具，后者不受手机打包上限约束。手机备份不包含登录配置、未登记临时文件或旧备份。下载后在 Safari 下载列表及「文件」中确认文件已保存，并保留一份服务器以外的副本。

恢复流程是「选择文件 → 上传并检查 → 查看数量 → 输入恢复 → 确认恢复并切换」。只接受本扩展的 `.yixu.gz` 完整备份。校验压缩体积、解压上限、路径、文件哈希、SQLite 版本、完整性、外键及媒体哈希。校验后若现衣橱发生了修改，需重新预览，不会使用旧确认覆盖新修改。

恢复到新的独立目录，切换前自动完整备份现衣橱，并保留旧数据库。切换后新编辑写入恢复副本；控制配置会记录新的活动数据目录，服务重启后继续使用该目录。凭证不会被恢复包替换。

恢复副本在 `$YIXU_MOBILE_CONTROL/restores/`；切换前完整备份在 `$YIXU_MOBILE_CONTROL/before-restore/`。只有过期且未被采用的预览副本会自动清理。旧库和切换前备份不自动删除。

恢复之后若运行 CLI：先查看控制配置中的 `dataDir`，将 `YIXU_DATA_DIR` 指向它，`YIXU_ORIGIN=http://127.0.0.1:4184`。不要继续维护初始旧目录。

## 运维

```bash
sudo systemctl status yixu-mobile --no-pager
sudo journalctl -u yixu-mobile -n 80 --no-pager
sudo journalctl -u caddy -n 80 --no-pager
```

改密码：使用相同 `YIXU_MOBILE_CONTROL` 再运行 setup 命令，再 `sudo systemctl restart yixu-mobile`。账户为单个主人密码；登录有效期七天，退出登录立即失效，重启服务使全部会话失效。连续失败登录有 15 分钟限流，网关会校验 Host、Origin、SameSite 与 CSRF token，Cookie 使用 Secure 与 HttpOnly。

如果需要回退，先停止 mobile 服务并备份其**当前活动数据目录**，再从切换前备份恢复到新目录，核对切换后新增数据。不要直接把旧库覆盖回去。未恢复切换过的初次安装可在停 mobile 服务后，以原目录和原启动器恢复本机服务；原本机服务没有登录保护，不能直接接到公网代理后。

## 验证范围

`npm test` 包含原项目测试及手机扩展的认证、CSRF、图片上传、重复检测、冲突保护、搭配保存、完整备份恢复、旧数据保留、路径穿越和篡改拒绝测试。浏览器流程另用 390×844 移动视口验证。真实 iPhone 的相册选择器、Safari 下载交互和目标云服务器证书签发需要部署后实机确认。

## 已确认的旧 Caddy + yixu.service：自动切换

如果原配置仅为 `127.0.0.1:4184` 转发到 `127.0.0.1:4183`，且旧衣橱由 `yixu.service` 管理，可以运行：

```bash
cd /home/ubuntu/apps/yixu-mobile
git pull --ff-only
YIXU_DATA_DIR=/home/ubuntu/apps/yixu/private-data bash scripts/deploy-existing-caddy.sh 你的公网IPv4
```

此脚本核对现有 Caddy 只有上述转发，核对运行中的旧服务的数据目录，安装依赖并运行测试，校验私人数据库并建立完整备份，另行备份 Caddyfile。输入新密码后，停止并禁用旧 `yixu.service`，配置新版 `yixu-mobile.service` 开机自启。新服务使用 **4186** 作为内部端口、**4185** 作为认证网关；旧 4184 转发不再使用。

Caddy 复用已有安装，HTTPS 使用公网 IP 对应的 sslip.io 地址，绑定路由所指向的本地 IPv4 网卡，保留 Tailscale 网卡的 443 监听。不会修改 Tailscale Serve/Funnel；原来指向 4184 的 Tailscale 链接将暂时不可用，请使用脚本输出的 HTTPS 地址。若要恢复 Tailscale 访问，应将其目标改为带登录保护的 4185 网关，且手机端访问 origin 要与网关配置一致，不应直接转发内部 4186。

切换过程中若新版不能启动或 Caddy 重载失败，脚本会停止新版，恢复原 Caddyfile，并按原状态启用/启动旧衣橱。备份保留不删除。脚本不等待外部证书签发；需在云安全组放行 80/443，再用 Safari 验证 HTTPS。现有配置与已确认结构不一致时脚本会退出，不覆盖其他网站。
