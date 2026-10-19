# SVG to HTML

简体中文 | [English](README.en.md)

将 SVG 设计稿转换为 HTML、Vue 或 React。这个仓库维护一套前端和 API 网关，同时用于自部署和在线试用；转换引擎由独立的 [svg-transform-core](https://github.com/cnzhhx/svg-transform-core) 镜像提供。

![SVG 与 HTML 对比](example/comparison-4.33.png)

示例视觉差异为 4.33%，仅代表该样本。[查看交互对比](example/comparison-4.33.html)。

## 本地启动

需要 Node.js 20+、pnpm 10.11+ 和 Docker：

```bash
pnpm dev
```

首次启动创建缺失的环境与模型配置。访问 `http://localhost:5173/transformer/`。真实转换前，填写 `backend/config/model-provider.json`，模型密钥仅在服务端保存。模型配置格式见该目录中的示例；修改模型后使用 `pnpm core:recreate` 让 Core 重新读取。在线运营设置不需要重启 Core。

## 首次管理员设置

在项目根目录生成一次性初始化码：

```bash
pnpm admin:setup-token
```

打开 `/transformer/setup`，填写初始化码、管理员账号及至少 12 位的密码，确认初始运营设置。初始化码 15 分钟有效、只能使用一次；未持有码的访客不能创建管理员。普通用户无需注册。

初始化完成后通过 `/transformer/login` 登录，在 `/transformer/admin/settings` 管理站点；工作区侧边栏也提供入口。管理员会话最长 7 天，服务重启、退出或修改密码后需要重新登录。

如果已有 ToC 管理员密钥，可在登录页选择“使用原管理员密钥迁移”，或使用旧的 `#adminKey=...` 入口，然后创建账号。创建成功后旧密钥和旧会话停止生效。

忘记密码时，在同一运行环境执行：

```bash
pnpm admin:reset-password
```

在登录页选择“恢复密码”，输入 15 分钟内有效的一次性恢复码和新密码。原账号名保留。账号名可由服务器管理员从运行数据中的管理员记录查看；不要对外提供运行数据文件。

## 在线运营设置

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| 访问隔离 | 开启 | 按浏览器 Cookie 隔离任务；公开示例除外 |
| 每日额度 | 开启，5 次 | 每浏览器每日上传次数；管理员不限额、不计入普通用量 |
| 额度时区 | Asia/Shanghai | 按该时区划分日期，修改后按新的日期边界计算 |
| SVG 上传大小 | 50 MB | 可设置 1–50 MB，管理员同样受文件大小限制 |
| 单任务预计耗时 | 20 分钟 | 仅用于排队等待估算，不改变转换并发 |
| 用户提交公开示例 | 允许 | 关闭后禁止新提交，不撤销已有示例 |

保存后新请求立即使用新设置，已接受的转换不受影响。其他页面会在重新获得焦点或定时刷新时更新。多人编辑发生版本冲突时，重新加载后再保存。

在“排队与并发”中可设置全站同时执行的 session 数（1–32），保存按钮位于底部。增加上限立即补入排队任务；降低上限等待现有任务自然完成，不中断任务。此设置不改变单 session 内的模块并发。需要支持 `GET/PUT /api/queue/settings` 的 Core；旧 Core 会显示升级提示，不能假保存。Core 在工作目录的 `queue-settings.json` 中持久保存实际执行上限，首次未保存时使用 `MAX_CONCURRENT_AGENTS`，重启后优先使用已保存值。此文件属于运行数据，备份时与 Core 工作目录一起保留，不能进入代码快照。排队估算读取 Core 的实际上限。

**关闭访问隔离会让全部已有任务对访客可见、可预览和下载。** 他人的任务仍只读；创建者和管理员可修改自己的授权任务。重新开启隔离不改变任务归属，并终止失去权限的活动事件流和下载流。已经下载的文件无法收回。

关闭每日额度时仍记录用量；重新开启不会清零。管理员可以在“公开示例”页面设置或取消任意任务的示例状态。普通用户不能删除示例，管理员可以删除。

Cookie 是匿名浏览器身份，不是正式用户账号。清除 Cookie 或切换浏览器会失去原有归属并获得新的额度身份；部署到公网时仍需按实际需求配置 TLS、入口限流等基础设施。

## 运行数据与迁移

网关默认在 `workspace/gateway/` 保存：

- `access-state.json`：原有任务归属、Cookie 标识哈希和每日用量。
- `gateway-state.json`：运营设置、示例覆盖状态、管理员密码哈希及初始化码哈希。
- `gateway-state.json.lock`：短暂的跨进程写锁。若异常退出残留，只能在确认相关服务和管理命令均已停止后删除。

通过 `SVG_TO_HTML_ACCESS_STATE_PATH` 指定归属账本位置，在线设置始终保存在其相邻目录。升级、迁移和备份必须一起保留两份 JSON；代码发布不会覆盖它们。首次迁移前先备份原账本和环境配置。

只有缺少在线设置文件时，才导入旧环境中的每日次数、时区、等待估算和示例 ID。之后网页设置优先，重启不会重新导入。损坏的文件会报错，不能通过自动重置恢复，以免丢失权限。

旧 Cookie 及归属账本格式保持兼容。Core 中未登记归属的历史任务，在隔离开启时仅管理员可见；管理员可将其设为公开示例。原有未绑定浏览器的 IP 归属记录继续支持一次性迁移绑定。

## 部署配置与发布

仍由部署环境配置的内容：端口、Core 地址、Core 镜像、模型与密钥、单 session 内的模块并发及数据路径。Core 执行 API（包括并发设置接口）仅供可信网关访问，不应直接暴露到公网；网关仅允许已登录管理员修改并发设置。

Ubuntu 首次部署：

```bash
sudo bash scripts/deploy-ubuntu.sh
```

模型配置默认位于 `/etc/svg-to-html/model-provider.json`，应用环境默认位于 `/etc/svg-to-html/app.env`。管理命令必须使用服务相同的环境和数据路径，例如在项目根目录通过具备该文件读取权限的服务用户运行：

```bash
ENV_FILE=/etc/svg-to-html/app.env pnpm admin:setup-token
```

不要通过 root 管理命令创建服务用户无法写入的运行数据；应保持数据目录的服务用户所有权。

后续只发布应用代码：

```bash
TOC_DEPLOY_HOST=ubuntu@your-server \
TOC_DEPLOY_DIR=/home/ubuntu/svg-to-html \
TOC_DEPLOY_URL=https://your-domain/transformer \
pnpm publish:app
```

`pnpm publish:toc` 仍是兼容别名。脚本包含当前工作目录的未提交修改、新文件和删除，在服务器暂存目录检查、测试和构建，随后备份、切换、重启网关并核验；切换失败恢复旧代码。有未完成任务时拒绝发布。脚本适配现有 `svg-to-html` systemd 服务与本机 4310 端口的 Core，保留其镜像、模型及任务数据，不更新 Core。

生产服务器地址没有源码默认值；使用环境变量或本地部署环境提供。不要将密钥或运行数据提交到 Git。

## 开发与验证

HTML/SVG 在线预览及浏览器缓存预览允许内联、同源和 Blob 脚本执行，以支持实时预览缩放及打包后的 Vue/React 页面。仍通过 CSP 禁止直接网络连接、表单提交、Worker 和插件，外部脚本未放行。预览保留同源能力，此策略不构成与管理后台的权限隔离，生成脚本应视为受信任代码。下载文件本身不作修改。

任务写接口需要 `X-Requested-With: svg-to-html`，浏览器提供的 `Origin` 必须与网关入口一致。反向代理应保留公开 Host 和协议；这些检查不能阻止同源预览脚本使用当前用户权限。

```bash
pnpm test              # 网关行为与发布回滚测试，使用模拟 Core
pnpm build             # 前端构建与网关类型检查
pnpm lint:frontend     # 前端类型检查
pnpm audit             # 依赖安全审计
pnpm doctor            # 环境检查
```

Core 不可用时，网关仍提供初始化、登录和设置页面，转换相关接口返回不可用提示。健康检查用于网关存活检查，不代表 Core 可用。

测试涵盖设置持久化、保存冲突、写盘失败、管理员迁移与恢复、额度开关和跨日退款、权限矩阵、活动流撤销及发布数据保留。不消耗模型额度。

路径穿越和预览安全回归包含在 `pnpm test` 中。可选浏览器验证需要本机 Chrome 和 Playwright：设置 `ARTIFACT_TEST_PLAYWRIGHT_PATH` 为 Playwright 的 `index.mjs` 绝对路径后运行 `pnpm test`。测试自动创建隔离浏览器上下文及临时运行目录，不使用个人浏览器数据。

## License

[MIT](LICENSE)。保留原有版权和许可声明。
