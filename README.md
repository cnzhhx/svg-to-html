# SVG to HTML

简体中文 | [English](README.en.md)

这是 `svg-transform-core` 的前端和 API 网关项目。当前仓库负责上传入口、任务列表、进度流、预览、下载和聊天修复 UI；真正的 SVG 转换、模型调用、浏览器渲染、产物写入和 Docker 部署由独立的 `svg-transform-core` 服务负责。

当前仓库不再创建或读取本地 session 产物，不启动本地 pipeline，也不直接依赖模型、浏览器或 opencode 执行转换。旧 session 数据不迁移、不展示、不兼容。

## 效果预览

以下示例展示了原始设计稿渲染与生成页面渲染的视觉对比。本次视觉差异为 **4.33%**，还原度约 **95.67%**。

![SVG 与 HTML 渲染对比](example/comparison-4.33.png)

| 原始设计稿渲染 | 生成页面渲染 | 视觉差异图 |
| --- | --- | --- |
| ![原始设计稿渲染](example/assets/comparison-4.33-source.png) | ![生成页面渲染](example/assets/comparison-4.33-html.png) | ![视觉差异图](example/assets/comparison-4.33-diff.png) |

> 完整交互对比页面：[`example/comparison-4.33.html`](example/comparison-4.33.html)

## 架构

```mermaid
flowchart LR
  UI["/transformer 前端"] --> GW["当前项目后端网关"]
  GW --> CORE["svg-transform-core"]
  CORE --> JOBS["jobs / events / preview / files / download"]
```

当前后端对外提供 `/transformer/api/jobs/*`，并转发到 core 的 `/api/jobs/*`：

- `GET /transformer/api/jobs`
- `POST /transformer/api/jobs`
- `GET /transformer/api/jobs/:id`
- `POST /transformer/api/jobs/:id/start`
- `POST /transformer/api/jobs/:id/messages`
- `GET /transformer/api/jobs/:id/events`
- `GET /transformer/api/jobs/:id/preview`
- `GET /transformer/api/jobs/:id/files/*`
- `GET /transformer/api/jobs/:id/download`
- `DELETE /transformer/api/jobs/:id`

预览、文件、下载和 SSE 中的 URL 会被重写为 `/transformer/api/jobs/...`，前端不会接触 core 内网地址或 Docker 内部路径。

## 快速开始

### 1. 启动 core Docker

当前项目开发和启动都要求 `svg-transform-core` 走 Docker，不再使用本地 `apps/server dev` 跑 core。默认要求 `svg-transform-core` 仓库与当前仓库同级：

```bash
corepack pnpm install
corepack pnpm core:start
corepack pnpm core:health
```

`corepack pnpm core:start` 会调用 `../svg-transform-core/scripts/docker-core.sh start`，复用已有容器；如果修改过 core 端口、环境变量、挂载、镜像或 model config 路径，使用：

```bash
corepack pnpm core:recreate
```

如果 core 仓库不在当前仓库同级，设置：

```bash
SVG_TRANSFORM_CORE_REPO=/absolute/path/to/svg-transform-core corepack pnpm core:start
```

core Docker 默认对外提供 `http://127.0.0.1:4310/health`。

### 2. 配置当前网关

```bash
cp .env.example .env
```

确保 `.env` 或环境变量中存在：

```bash
PORT=81
SVG_TRANSFORM_CORE_URL=http://127.0.0.1:4310
```

`SVG_TRANSFORM_CORE_URL` 是必填项。当前后端启动时会请求 `${SVG_TRANSFORM_CORE_URL}/health`，未配置或不可达会直接退出。

### 3. 构建并启动当前项目

```bash
corepack pnpm install
corepack pnpm -C frontend build
corepack pnpm start
```

访问：

```text
http://localhost:81/transformer
```

## 服务管理

```bash
corepack pnpm core:start                            # 启动 core Docker
corepack pnpm core:recreate                         # 重建 core Docker 容器
corepack pnpm core:status                           # 查看 core Docker 状态
corepack pnpm core:logs                             # 查看 core Docker 日志
corepack pnpm core:stop                             # 停止 core Docker

bash backend/scripts/start-linux.sh start       # 后台启动
bash backend/scripts/start-linux.sh stop        # 停止
bash backend/scripts/start-linux.sh restart     # 重启
bash backend/scripts/start-linux.sh status      # 查看状态
bash backend/scripts/start-linux.sh logs        # 查看日志
bash backend/scripts/start-linux.sh foreground  # 前台运行
```

`corepack pnpm dev`、`corepack pnpm start` 和 `backend/scripts/start-linux.sh start` 都会先确保 core Docker 已启动，再启动当前网关。

`backend/scripts/deploy.sh` 仍然是本地脚本：先把代码复制到目标机器，再在目标机器运行。它不会做 SSH/SCP 编排；启动当前网关前会通过本地 Docker 拉起 core。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 20+（推荐 22+） | 当前网关运行时 |
| pnpm via Corepack | 10.11+ | 项目 `packageManager` 字段指定 |
| Docker Desktop / Docker Engine | 可用 | core 必须通过 Docker 启动 |
| svg-transform-core | 同级仓库或 `SVG_TRANSFORM_CORE_REPO` 指定路径 | 当前项目会调用它的 Docker helper |

浏览器、模型 provider、opencode、CDP、workspace、并发和 diff 阈值都属于 `svg-transform-core` 的运行配置，不属于当前网关配置。

## 环境变量

当前 Web 网关关键变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `80` | 当前网关 HTTP 监听端口 |
| `SVG_TRANSFORM_CORE_URL` | 无 | 必填，core 服务地址，例如 `http://127.0.0.1:4310` |
| `SVG_TRANSFORM_CORE_REPO` | `../svg-transform-core` | core 仓库路径 |
| `SVG_TRANSFORM_CORE_MODEL_CONFIG` | core 仓库内 `.runtime/model-provider.json` | core Docker 挂载的模型配置 |

当前网关不会读取浏览器、模型 provider、opencode、CDP、workspace、并发或 diff 阈值变量；这些变量应配置在 `svg-transform-core`。

## 验证

```bash
corepack pnpm -C backend run lint:types
corepack pnpm -C frontend build
corepack pnpm build
```

core 启动后可以直接检查：

```bash
curl http://127.0.0.1:81/transformer/health
curl http://127.0.0.1:81/transformer/api/jobs
```

## 项目结构

```
backend/
  src/                    Express 网关源码
  scripts/                 本地安装、启动和部署脚本
frontend/
  src/                    React 18 前端源码
  public/                 React build 后的静态产物，供后端服务
example/                  可发布的还原度对比示例
```

## License

[MIT](LICENSE)
