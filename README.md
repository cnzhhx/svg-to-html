# SVG to HTML

简体中文 | [English](README.en.md)

将 SVG 设计稿像素级还原为真实、可维护的 HTML/CSS 页面（同时支持 Vue / React 输出）。

## 效果预览

以下示例展示了原始 SVG 渲染与生成 HTML 渲染的对比，像素 diff 为 **4.33%**。

![SVG 与 HTML 渲染对比](example/comparison-4.33.png)

| 原始 SVG 渲染 | 生成 HTML 渲染 | 像素 Diff |
| --- | --- | --- |
| ![Original SVG](example/assets/comparison-4.33-source.png) | ![Generated HTML](example/assets/comparison-4.33-html.png) | ![Pixel diff](example/assets/comparison-4.33-diff.png) |

> 完整交互对比页面：[`example/comparison-4.33.html`](example/comparison-4.33.html)

## 特性

- **像素级还原** — 以 SVG 渲染与 HTML 渲染的像素 diff 驱动修复
- **真实 HTML/CSS 输出** — 还原为语义化 DOM 结构，而非嵌入 SVG
- **多格式输出** — 支持 HTML、Vue、React 组件输出
- **DOM 文本保留** — 可读文本保留为真实 DOM 文本节点
- **模块化生成** — 大型设计稿自动拆分为语义模块，并行生成
- **智能预处理** — 预提取文本（OCR）、布局框、颜色、图标、背景
- **验证闭环** — 模块级 + 全页级像素 diff 反馈，自动修复
- **自动回滚** — diff 退化时自动回滚到最优快照
- **Web UI + CLI** — 提供浏览器界面和完整 CLI 工具集

## 快速开始

### 一键部署（Linux / macOS）

```bash
bash scripts/deploy.sh
```

该脚本自动完成：系统依赖安装、Node.js、pnpm、浏览器、项目依赖和服务启动。

### 手动部署

```bash
# 1. 安装依赖
pnpm install

# 2. 环境检查
pnpm run doctor

# 3. 配置模型
cp config/model-provider.example.json config/model-provider.json
# 编辑 config/model-provider.json 填入 provider 信息

# 4. 构建 MCP server（浏览器验证所需）
pnpm run build:mcp

# 5. 启动服务
pnpm start
# 访问 http://localhost:80/transformer
```

### 服务管理

```bash
bash scripts/start-linux.sh start       # 后台启动
bash scripts/start-linux.sh stop        # 停止
bash scripts/start-linux.sh restart     # 重启
bash scripts/start-linux.sh status      # 查看状态
bash scripts/start-linux.sh logs        # 查看日志
bash scripts/start-linux.sh foreground  # 前台运行（带自动重启保护）
```

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 20+（推荐 22+） | |
| pnpm | 10.11+ | 项目 `packageManager` 字段指定 |
| Chrome / Chromium / Edge | 最新版 | 用于渲染和截图 |
| opencode CLI | 可选 | 用于 `opencode` runtime |

安装脚本 `scripts/install-linux.sh` 可在 Linux 和 macOS 上自动安装以上全部依赖。

## 配置

### 模型配置

编辑 `config/model-provider.json`（从 `config/model-provider.example.json` 复制）：

```json
{
  "moduleAgentModel": "your-model",
  "otherModel": "your-model",
  "models": {
    "your-model": {
      "runtime": "opencode",
      "provider": "your-provider",
      "baseURL": "https://api.example.com/v1",
      "apiKeyEnv": "YOUR_PROVIDER_API_KEY",
      "model": "your-model-id"
    }
  }
}
```

### 环境变量

所有配置可通过 `.env` 文件设置，关键变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `80` | HTTP 监听端口 |
| `WORKSPACE` | `./workspace` | Session 产物根目录 |
| `NODE_ENV` | `development` | 运行环境 |
| `MAX_CONCURRENT_AGENTS` | `2` | 同时运行的 session 数 |
| `MAX_PARALLEL_MODULE_AGENTS` | `5` | 单 session 并行模块数 |
| `DIFF_RATIO_THRESHOLD` | `0.05` | 全页 diff 合格阈值（5%） |
| `CHROMIUM_PATH` | 自动检测 | 浏览器二进制路径 |
| `SESSION_CHAT_DISABLED` | `1` | 禁用聊天修复入口和后端消息接口 |
| `SESSION_DELETE_DISABLED` | `0` | 禁用删除 session |

完整列表见 `.env` 文件。

## CLI 工具

```bash
# 生成（preflight：布局分析 + scaffold + 模块规划）
pnpm run task:generate -- <svg-path> --format html|vue|react

# 页面级像素 diff 验证
pnpm run task:verify -- <svg-path>

# 模块级验证
pnpm run task:verify-module -- --module-dir <dir> --module-id <id> ...

# 拆分模块
pnpm run task:split-svg-modules -- <svg-path>

# 环境诊断
pnpm run doctor

# 类型检查
pnpm exec tsc --noEmit
```

## 工作原理

```mermaid
flowchart TD
  A[SVG 设计稿] --> B[布局预处理]
  B --> C[模块规划]
  C --> D[模块 SVG 裁剪 + 语义分析]
  D --> E[模块 Agent 并行还原]
  E --> F[模块级验证 + 回滚]
  F --> G[合并全部模块]
  G --> H[全页验证]
  H --> I[最终 HTML/CSS/Vue/React 输出]
```

## 项目结构

```
src/
  cli/                    CLI 入口
  config/                 运行时、模型和验证配置
  core/                   SVG 解析、渲染、diff、OCR、布局、策略
  pipeline/               Agent 编排、模块生成、合并、验证
  routes/                 Express HTTP API
  session-store/          Session 状态、持久化、事件
  prompts/                Agent 提示词模板
public/                   Web UI 前端
config/                   模型配置
scripts/                  安装、部署和诊断脚本
example/                  可发布的对比示例
workspace/                生成的 session 和产物（git 忽略）
```

## License

[MIT](LICENSE)
