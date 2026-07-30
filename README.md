# SVG to HTML

简体中文 | [English](README.en.md)

基于 `svg-transform-core` 的 SVG 转网页工具。当前仓库提供 Web UI 和 API 网关，转换流程由已发布的 Core Docker 镜像执行，不需要下载 Core 源码。

## 效果

下面示例的视觉差异为 **4.33%**，还原度约 **95.67%**。

![SVG 与 HTML 渲染对比](example/comparison-4.33.png)

> [查看完整交互对比](example/comparison-4.33.html)

## 本地启动

需要 Node.js 20+、pnpm 10.11+ 和 Docker：

```bash
npm install -g pnpm@10.11.0
pnpm dev
```

首次启动会自动安装依赖，并创建 `.env` 和模型配置。访问 `http://localhost:5173/transformer`。

## 配置模型（必填）

服务可以使用占位配置启动，但执行 SVG 转换前必须填写真实模型：

| 环境 | 配置文件 |
| --- | --- |
| 本地开发 | `backend/config/model-provider.json` |
| Ubuntu 部署 | `/etc/svg-to-html/model-provider.json` |

最小配置示例：

```json
{
  "models": {
    "my-model": {
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

- `my-model`：页面中显示和提交的模型配置 ID，可以自定义。
- `provider`：接口协议类型；OpenAI 兼容接口使用 `openai`。
- `baseURL`：模型服务的 API 地址。
- `apiKey`：模型密钥。
- `model`：模型服务实际使用的模型 ID。

修改后让 Core 重新读取配置：

```bash
pnpm core:recreate                          # 本地
sudo bash scripts/service-ubuntu.sh restart # Ubuntu
```

本地模型配置已被 Git 忽略；Ubuntu 模型配置位于仓库外，部署更新不会覆盖它。

## Ubuntu 部署

```bash
sudo bash scripts/deploy-ubuntu.sh
```

脚本会安装 Node.js、pnpm、Docker 和 Nginx，创建外置配置并启动服务。部署后填写 `/etc/svg-to-html/model-provider.json`、重启服务，然后访问 `http://SERVER_IP/transformer/`。

源码更新后重复执行部署命令即可重新部署，不会覆盖已有配置。部署脚本默认公开监听 80 端口且不内置鉴权；公网使用时请在 Nginx 前补充 TLS 和访问控制。

## 常用命令

```bash
pnpm dev                 # 本地启动
pnpm doctor              # 环境检查
pnpm core:logs           # Core 日志
pnpm core:recreate       # 重建 Core
pnpm core:update         # 更新 Core 镜像
pnpm core:stop           # 停止 Core
```

任务接口没有内置鉴权，请不要直接暴露本地开发端口。

## License

[MIT](LICENSE)
