# 部署与维护

[返回首页](../../README.md) · [English](deployment.en.md) · [配置指南](configuration.md) · [管理员指南](administration.md)

## 服务结构

浏览器通过 `/transformer/` 访问应用。开发时 Vite 代理 API 请求；生产环境由 Nginx 转发到网关，网关同时提供构建后的前端文件。网关连接独立 Core，Core 调用配置的模型服务并保存任务产物。

| 服务 | 默认地址或端口 | 用途 |
| --- | --- | --- |
| 开发前端 | `http://localhost:5173/transformer/` | 本地开发页面 |
| API 网关 | `127.0.0.1:8081` | 前端静态文件、任务访问、管理员与运营策略 |
| 转换 Core | `127.0.0.1:4310` | 转换执行、任务产物和执行并发 |
| Nginx | `80`，HTTPS 由部署者配置 | 对外入口与反向代理 |

网关绑定本机回环地址，Core 管理脚本也只将容器端口映射到回环地址。Core 执行 API 应仅供可信网关访问。

## Ubuntu 首次安装

适用于具备 sudo 权限、使用 systemd 的 Ubuntu 主机。选择运行应用的普通用户克隆仓库，仓库路径不要放在只有 root 可访问的目录中：

```bash
git clone https://github.com/cnzhhx/svg-to-html.git
cd svg-to-html
sudo bash scripts/deploy-ubuntu.sh
```

脚本会安装系统依赖，准备外部配置和数据目录，安装依赖并执行测试、构建与类型检查，启动 Core，配置 `svg-to-html` systemd 服务和 Nginx，然后检查健康状态。

安装会写入对应的 systemd 与 Nginx 配置，仅允许替换发行版未修改的 Nginx 默认站点；检测到自定义默认站点时会拒绝替换。已有业务的服务器应先检查配置并备份。此脚本用于首次系统配置，后续应用更新使用[应用代码发布](#应用代码发布)。

| 文件或目录 | 默认位置 |
| --- | --- |
| 应用环境 | `/etc/svg-to-html/app.env` |
| 模型配置 | `/etc/svg-to-html/model-provider.json` |
| 网关运行数据 | 项目中的 `workspace/gateway/` |
| Core 工作目录 | 项目中的 `workspace/core/` |
| systemd 服务 | `svg-to-html` |
| Nginx 站点配置 | `/etc/nginx/sites-available/svg-to-html` |

脚本为缺失配置创建模板；模板密钥和模型占位值无法用于真实转换。按[配置指南](configuration.md)填写模型信息；若 Core 已经启动，需要在无活动任务时让它重新加载模型。默认入口为 `http://服务器地址/transformer/`。

可通过 `ENV_FILE`、`SVG_TO_HTML_SERVICE_USER` 和 `SVG_TO_HTML_SERVICE_NAME` 自定义首次安装，但应用发布脚本面向默认的 `svg-to-html` 服务和本机 `4310` 端口 Core；修改布局后需要自行核对发布适配。

## 初始化管理员

管理命令必须使用与网关服务相同的环境和数据路径。默认安装的 `/etc/svg-to-html/app.env` 只有 root 能读取，而运行数据应由服务用户写入。在项目根目录执行以下命令，由受权 shell 读取环境，再切换为 systemd 中配置的服务用户运行初始化：

```bash
sudo bash -c '
set -euo pipefail
set -a
. /etc/svg-to-html/app.env
set +a
export ENV_FILE=/dev/null
service_user="$(systemctl show svg-to-html -p User --value)"
test -n "$service_user"
exec runuser -u "$service_user" -- pnpm admin:setup-token
'
```

这里的 `ENV_FILE=/dev/null` 让管理命令使用已载入的环境，避免再次尝试读取受保护文件。命令不改变配置文件权限，实际管理数据也不由 root 写入。自定义安装应对应调整环境文件和服务名称。

然后访问 `/transformer/setup` 创建账号。恢复密码时使用同一段命令，将最后的 `pnpm admin:setup-token` 改为 `pnpm admin:reset-password`。

如果运行身份本身已具备读取环境文件和写入数据的权限，也可以直接执行：

```bash
ENV_FILE=/etc/svg-to-html/app.env pnpm admin:setup-token
```

不要公开密钥文件，也不要用 root 管理命令创建服务用户无法写入的运行文件。初始化码和恢复码只供服务器管理员查看，不要粘贴到 Issue 或公开日志。

## 反向代理

保留 `/transformer/` 前缀。下面的片段与安装脚本的主要代理参数一致，可用于已有 Nginx 站点；`8081` 需要与网关的 `PORT` 一致：

```nginx
location /transformer/ {
    # 预留 multipart 包装空间；网关单独执行 SVG 文件大小限制。
    client_max_body_size 51m;
    proxy_pass http://127.0.0.1:8081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

任务进度使用事件流，关闭代理缓冲可让更新及时到达。保留公开 Host 与协议有助于同源校验正确工作。公网部署需要自行配置域名、HTTPS 和入口限流；安装脚本默认只提供 HTTP。

## 应用代码发布

从开发机器发布到已有安装，需要 SSH 密钥认证、远端免密 sudo，以及本地 `ssh`、`rsync`。服务器应已具备 Node.js 和 pnpm。使用部署者自己的目标值：

```bash
TOC_DEPLOY_HOST=ubuntu@your-server \
TOC_DEPLOY_DIR=/home/ubuntu/svg-to-html \
TOC_DEPLOY_URL=https://your-domain/transformer \
pnpm publish:app
```

`TOC_DEPLOY_URL` 填应用根 URL，不带结尾斜杠。源码不提供个人服务器地址或密钥。`pnpm publish:toc` 是兼容别名。

发布快照包含当前工作目录的未提交源码、新文件和删除，因此发布前应先审阅 Git 差异。环境文件、模型密钥、运行数据和本地规划文档不进入快照。`docs/` 下的指南通过 Git 分发，不作为网站运行文件上传。

发布脚本会先在远端暂存目录校验、安装依赖、测试和构建，再检查活动任务。存在未完成任务时拒绝切换，等待任务结束后重新发布，不要终止任务来绕过检查。

切换前备份原有代码和依赖，保留私有配置；切换后重启网关，核对健康状态、模型列表和公开静态文件。启用新版本失败时恢复旧代码和依赖。备份位置会在发布输出中显示，默认位于项目相邻的 `svg-to-html-backups/`。这不是运行数据备份。

应用发布保留 Core 镜像、模型和任务数据。Core 升级应单独评估，在任务完成后的维护窗口执行；`service-ubuntu.sh restart/update` 会涉及 Core，不作为仅更新网页和网关的替代命令。

## Core v0.2.2 升级

更新应用代码不会修改已有环境文件或运行中的 Core。单独升级 Core 前，等待活动任务结束，备份下列运行数据，再将对应环境文件中的 `SVG_TRANSFORM_CORE_IMAGE` 改为 `ghcr.io/cnzhhx/svg-transform-core:0.2.2`，使用相同的 `ENV_FILE` 执行 `pnpm core:update`。

新镜像以 uid/gid `1000:1000` 运行。Linux 上已有 Core 工作目录需要允许 uid `1000` 写入；模型文件需要允许该用户或文件所属组读取。启动脚本自动将模型文件的组加入容器，并在重建前用临时容器检查挂载权限；检查失败会保留原容器和已有权限。首次安装仅为新建工作目录设置所有者，已有数据的权限调整由部署者审阅后执行。

容器停止时预留 35 秒，让 Core 完成最长 30 秒的状态落盘。升级后除 `/health` 外，还可检查 `http://127.0.0.1:4310/ready`，确认工作目录、浏览器、执行器和模型配置可用；该检查不调用模型，也不验证模型服务连通性。

v0.2.2 的默认下载是带有校验清单和运行说明的交付 ZIP。页面另提供“下载诊断包”，用于分析文件和执行历史；升级前的历史任务尚无交付包时会使用诊断下载。浏览器预览缓存只用于离线查看，在线任务下载始终由 Core 提供完整包。

## 备份与迁移

| 内容 | 必须保留的原因 |
| --- | --- |
| `access-state.json` | 任务归属、Cookie 标识哈希和每日用量 |
| 相邻的 `gateway-state.json` | 运营设置、示例覆盖、管理员密码及初始化码哈希 |
| 整个 Core 工作目录 | 历史任务、生成文件及 `queue-settings.json` 中的执行并发 |
| 环境文件与模型配置 | 恢复服务连接、数据路径及模型访问 |

网关在线设置始终位于 `SVG_TO_HTML_ACCESS_STATE_PATH` 的相邻目录。两份网关 JSON 应一起备份和恢复；备份本身也包含敏感信息，需要限制访问。

迁移前等待任务自然结束，暂停相关服务和管理命令的写入后制作一致备份。恢复时使用同一份环境配置，核对数据路径、文件所有权和服务用户写权限，再启动服务。代码备份或重新克隆仓库不能替代运行数据备份。

旧 Cookie 和归属账本格式保持兼容。Core 中未登记归属的历史任务在隔离开启时仅管理员可见，管理员可将其设为公开示例；旧的未绑定浏览器的 IP 归属记录仍支持一次性迁移绑定。

损坏的运行文件会明确报错，不会自动重置。`gateway-state.json.lock` 是短暂写锁；异常退出后如有残留，只能在确认网关和所有管理命令均已停止后处理，不要在服务运行中删除。

## 预览与访问安全

在线 HTML / SVG 和浏览器缓存预览允许内联、同源和 Blob 脚本，以支持实时预览缩放及打包后的 Vue / React 页面。CSP 仍禁止直接网络连接、表单提交、Worker 和插件，未放行外部脚本；下载文件本身不作修改。

预览保留应用同源能力，这套策略不构成与管理员后台的权限隔离。生成脚本应视为受信任代码。为不受信任来源提供公开服务前，需要根据自己的使用场景评估这一边界。

任务写接口要求 `X-Requested-With: svg-to-html`；浏览器提供的 `Origin` 必须与网关入口一致。这些检查不能阻止同源预览脚本使用当前用户权限。访问隔离关闭后的数据可见性详见[管理员指南](administration.md#访问隔离)。

## 状态与排障

### 检查服务

以下命令只查看状态或日志，不重新创建 Core：

```bash
sudo systemctl status svg-to-html --no-pager
sudo journalctl -u svg-to-html -n 100 --no-pager
curl --fail http://127.0.0.1:8081/transformer/health
curl --fail http://127.0.0.1:4310/health
```

在本地开发环境可以使用 `pnpm doctor`、`pnpm core:status` 和 `pnpm core:health` 检查依赖、模型文件及 Core 健康状态。`pnpm doctor` 默认读取仓库根目录 `.env`；外部部署配置需要与当前检查环境对齐。

| 现象 | 优先检查 |
| --- | --- |
| 网关正常但无法转换 | Core 健康状态、`SVG_TRANSFORM_CORE_URL` 和模型配置；网关健康不代表 Core 可用 |
| 模型列表为空或仍是示例 ID | 网关读取的模型路径、JSON 格式及占位值 |
| 上传提示文件过大 | 管理页的 SVG 大小上限，以及反向代理的请求体限制 |
| 页面进度长时间不更新 | 反向代理事件流缓冲、超时和网络连接 |
| 管理写请求被拒绝 | 登录状态、公开 Host / 协议、同源请求头及设置版本冲突 |
| 管理命令后设置似乎丢失 | 是否使用服务相同的 `ENV_FILE`、账本路径和运行身份 |
| 切换浏览器后找不到任务 | 匿名归属依赖原浏览器 Cookie；不是用户账号同步 |
| 运行数据无法写入 | 目录权限、磁盘空间及文件所有权，不要通过删除账本解决 |

Core 不可用时，网关仍提供初始化、登录和设置页面；转换相关接口返回不可用提示。
