# 配置指南

[返回首页](../../README.md) · [English](configuration.en.md) · [管理员指南](administration.md) · [部署与维护](deployment.md)

应用有两类配置：连接服务所需的环境与模型配置，以及管理员在网页中保存的站点策略。日常调整额度、访问隔离和示例状态时，使用管理员页面即可。

## 模型配置

本地默认文件为 `backend/config/model-provider.json`，模板见 [model-provider.example.json](../../backend/config/model-provider.example.json)。以下是模板使用的配置结构：

```json
{
  "models": {
    "my-vision-model": {
      "runtime": "opencode",
      "provider": "openai",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "your-api-key",
      "model": "your-model-id",
      "modalities": {
        "input": ["text", "image"],
        "output": ["text"]
      }
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `models` 下的键 | 页面展示的模型配置 ID，可配置多个不同 ID |
| `runtime`、`provider` | Core 的运行时与模型服务适配方式；以上沿用仓库模板 |
| `baseURL` | 模型服务的 API 地址，示例地址需要替换 |
| `apiKey` | 模型服务密钥，只保存在服务端 |
| `model` | 上游服务实际接收的模型名称 |
| `modalities` | 模型输入和输出能力，转换所用模型需要支持图文输入 |

应用从配置文件读取模型 ID，转换由 Core 完成；页面出现某个 ID 不代表该模型已经通过连通性检查。其他运行时或服务商的支持情况以 [Core 项目](https://github.com/cnzhhx/svg-transform-core)为准。

Ubuntu 安装默认使用 `/etc/svg-to-html/model-provider.json`。通过 `SVG_TRANSFORM_CORE_MODEL_CONFIG` 可以指定其他文件；网关与 Core 应使用同一份配置。

模型配置以只读文件挂载到 Core。修改模型后，需要在没有活动转换任务时执行 `pnpm core:recreate`，让 Core 重新读取。服务器上应携带相同的 `ENV_FILE`。该命令会重建 Core 容器，不能用于日常应用代码发布。

## 环境变量

本地从项目根目录的 `.env` 读取配置，模板见 [.env.example](../../.env.example)。网关、Core 管理脚本和管理员命令可以通过 `ENV_FILE` 指定外部环境文件。下表默认值以仓库提供的模板为准。

| 变量 | 模板默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `8081` | API 网关端口 |
| `SVG_TRANSFORM_CORE_URL` | `http://127.0.0.1:4310` | 网关连接的 Core 地址 |
| `SVG_TRANSFORM_CORE_IMAGE` | `ghcr.io/cnzhhx/svg-transform-core:0.2.2` | Core 镜像，固定版本便于复现 |
| `SVG_TRANSFORM_CORE_WORKSPACE` | `./workspace/core` | Core 工作目录，保存任务及产物 |
| `SVG_TRANSFORM_CORE_MODEL_CONFIG` | 本地 `backend/config/model-provider.json` | 模型配置文件；Ubuntu 安装默认使用外部配置 |
| `SVG_TO_HTML_ACCESS_STATE_PATH` | `./workspace/gateway/access-state.json` | 任务归属和用量账本；网关设置保存在相邻目录 |
| `MAX_CONCURRENT_AGENTS` | `1` | Core 尚未保存在线并发设置时的初始 session 并发 |
| `MAX_PARALLEL_MODULE_AGENTS` | `4` | 单个 session 内的模块并发，与站点并发不同 |

Core 脚本还支持 `SVG_TRANSFORM_CORE_CONTAINER`（默认 `svg-transform-core`）、`SVG_TRANSFORM_CORE_PORT` 和 `SVG_TRANSFORM_CORE_ENV_FILE`。通常保留默认即可；自定义端口时，确保网关 URL 与容器映射一致。额外 Core 环境文件也可能包含密钥，应按私有配置保管。

默认适配 Core v0.2.2，启动脚本与诊断工具未配置镜像时也使用固定的 `0.2.2` 标签。HTTP 客户端保留 npm 已发布的 `@svg-transform/core-client@0.2.0`；Core 的 Docker 版本和客户端包版本独立。

上传页通过 Core 的 `/ready` 能力信息显示可用格式：HTML、Vue、React，以及已安装 Flutter SDK 的 Core 所支持的 Flutter。官方 `0.2.2` 镜像未包含 Flutter SDK；使用自备 SDK 的 Core 才会出现 Flutter 选项。旧 Core 未提供该接口时保留原有三种格式。

Flutter 结果在站内使用截图对比，完整应用下载 ZIP 后运行。Flutter Web 依赖的资源加载与当前预览的网络、Worker 和 base URI 限制不兼容，因此不提供最终 Flutter 应用的在线运行入口。

文件中的相对工作目录与数据路径相对于仓库根目录解析。自定义模型文件建议使用绝对路径。

开发前端固定使用 `/transformer/` 基础路径，默认端口为 `5173`，从根目录 `.env` 的 `PORT` 获取网关代理端口。若使用外部 `ENV_FILE` 并修改了网关端口，启动前端时还应显式传入相同的 `PORT`；Vite 不会自行读取外部环境文件。

## 网页中的运营设置

在 `/transformer/admin/settings` 中修改：

- 按浏览器隔离任务。
- 每日上传额度、额度时区和最大 SVG 大小。
- 单任务预计耗时。
- 用户公开示例提交权限及已有任务的示例状态。
- 全站同时执行的 session 数，要求 Core 支持队列设置接口。

网关策略保存在 `gateway-state.json`，保存后对新请求生效，无需重启服务。Core 单独保存实际执行并发；修改“单任务预计耗时”只影响等待估算。详细行为见[管理员指南](administration.md)。

## 旧环境配置的导入

以下变量仅用于兼容旧安装：

| 变量 | 用途 |
| --- | --- |
| `SVG_TO_HTML_DAILY_UPLOAD_LIMIT` | 初次创建在线设置时导入每日次数 |
| `SVG_TO_HTML_DAILY_QUOTA_TIME_ZONE` | 导入额度时区 |
| `SVG_TO_HTML_ESTIMATED_TASK_MINUTES` | 导入单任务耗时估算 |
| `SVG_TO_HTML_SHOWCASE_JOB_IDS` | 导入已有公开示例 |
| `SVG_TO_HTML_ADMIN_KEY` | 旧管理员密钥迁移入口，不用于创建新安装的管理员 |

仅缺少 `gateway-state.json` 时导入旧运营配置。已有在线设置后，修改这些变量或重启服务不会覆盖网页保存的值。不要删除运行文件来“重新加载配置”。旧管理员账号迁移见[管理员指南](administration.md#从旧管理员密钥迁移)。

## 配置生效方式

| 修改内容 | 如何生效 |
| --- | --- |
| 网关运营设置 | 网页保存后，新请求立即使用；已接受的任务继续执行 |
| 全站 session 并发 | 在“排队与并发”保存；Core 在线调整并持久保存 |
| 网关端口、Core URL 或账本位置 | 在维护窗口重启网关，确认数据路径正确 |
| 模型配置、Core 镜像或模块并发 | 在无活动任务时重建 Core；修改镜像标签前先核对兼容性 |

环境文件、真实模型配置和运行数据不应提交到 Git。完整备份范围见[部署指南](deployment.md#备份与迁移)。
