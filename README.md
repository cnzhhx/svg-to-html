<div align="center">

# SVG to HTML

将 SVG 设计稿转换为 HTML、Vue、React 或 Flutter，在浏览器中对比效果、调整模块并下载源码。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-18-149eca.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![Core: Docker](https://img.shields.io/badge/Core-Docker-2496ed.svg)](https://github.com/cnzhhx/svg-transform-core)

简体中文 | [English](README.en.md)

[在线体验](https://lkti.cloud/transformer/) · [效果展示](#效果展示) · [快速开始](#快速开始) · [部署指南](docs/guides/deployment.md) · [参与贡献](CONTRIBUTING.md)

交流社区：[LINUX DO](https://linux.do/)

</div>

## 项目介绍

SVG to HTML 提供从上传设计稿到检查、调整和导出代码的网页工作区，适合将 SVG 页面设计转成前端实现，也可以自部署为团队或访客使用的转换站点。

本仓库维护 React 前端与 API 网关，实际转换由独立的 [svg-transform-core](https://github.com/cnzhhx/svg-transform-core) Docker 服务完成。自部署和在线试用使用同一套应用；模型服务由部署者配置，真实转换会调用所配置的模型 API。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| 多种源码格式 | 上传 SVG，选择 HTML、Vue、React，或 Core 已启用的 Flutter，以及 1× / 2× 渲染倍率 |
| 转换进度 | 查看任务队列、工作流阶段、模块执行情况和对话记录 |
| 效果对比 | 分列或滑块查看设计稿与生成结果，调整预览宽度，查看视觉差异 |
| 模块调整 | 选中模块，通过聊天提交具体的调整要求 |
| 源码交付 | 打开对照页、源码或渲染预览，下载完整交付 ZIP 或诊断包，查看独立的质量检查状态 |
| 公开示例 | 展示可供所有访客查看的转换结果，由管理员管理示例状态 |
| 站点管理 | 在网页中设置访问隔离、每日额度、文件大小限制和排队并发 |

## 效果展示

![SVG 设计稿与生成 HTML 的效果对比](example/comparison-4.33.png)

这个样本的视觉差异为 **4.33%**。[查看交互对比文件](example/comparison-4.33.html)（下载后用浏览器打开）。结果取决于设计稿、模型和配置，该数字仅代表这个样本。

## 快速开始

### 1. 准备环境

| 依赖 | 要求 |
| --- | --- |
| Node.js | 推荐 22 LTS，版本至少 22.12；也支持 20.19+ 的 Node.js 20 |
| pnpm | 10.11.0，与仓库 `packageManager` 保持一致 |
| Docker | 已安装，且 Docker 服务正在运行 |
| 命令行 | Git、Bash、curl；macOS / Linux 可使用下方命令，Windows 请使用 WSL2 |
| 模型服务 | 准备支持文本和图像输入的模型及对应 API 凭据 |

尚未安装 pnpm 时，可执行 `npm install -g pnpm@10.11.0`。

### 2. 获取代码并准备配置

以下步骤适用于全新克隆；升级已有安装时请保留原配置和运行数据。

```bash
git clone https://github.com/cnzhhx/svg-to-html.git
cd svg-to-html
pnpm install --frozen-lockfile

cp .env.example .env
cp backend/config/model-provider.example.json backend/config/model-provider.json
```

编辑 `backend/config/model-provider.json`，将示例中的 `baseURL`、`apiKey` 和 `model` 替换为模型服务的实际值。`models` 下的键是上传页面中选择的“模型配置 ID”。完整格式见[配置指南](docs/guides/configuration.md)。

### 3. 启动应用

```bash
pnpm dev
```

脚本会拉取本地尚不存在的 Core 镜像、启动 Core，并启动前端和网关。首次拉取镜像可能需要一些时间；缺失的环境文件和模型配置会从模板创建，但仍需填写有效模型凭据才能转换。

打开 [http://localhost:5173/transformer/](http://localhost:5173/transformer/)。默认网关端口为 `8081`，Core 端口为 `4310`。已有独立 Core 的开发方式见[贡献指南](CONTRIBUTING.md#连接已有-core)。

### 4. 创建管理员

在项目根目录的另一个终端执行：

```bash
pnpm admin:setup-token
```

打开[初始化页面](http://localhost:5173/transformer/setup)，使用终端输出的初始化码创建管理员账号，并设置至少 12 位的密码。初始化码 15 分钟内有效，只能使用一次。

之后通过[管理员登录页](http://localhost:5173/transformer/login)进入[站点设置](http://localhost:5173/transformer/admin/settings)。普通访客无需注册。服务器部署时，管理员命令需要使用服务相同的环境和数据路径，详见[部署指南](docs/guides/deployment.md#初始化管理员)。

## 使用流程

1. 点击“上传 SVG”，选择设计稿、源码格式、渲染倍率和模型配置。
2. 提交后查看排队状态、转换进度和模块执行过程。
3. 在结果区域用分列或滑块对比效果；需要继续调整时，选中模块并在“聊天调整”中输入要求。
4. 打开源码或渲染预览，下载 ZIP 后按生成项目的结构继续开发。

默认按浏览器隔离任务；勾选“加入公开示例”的任务可被其他访客查看。浏览器 Cookie 用于记录匿名任务归属，清除 Cookie 或切换浏览器后不会自动找回原有任务。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [配置指南](docs/guides/configuration.md) | 模型配置、环境变量、端口与数据路径、配置生效方式 |
| [管理员指南](docs/guides/administration.md) | 初始化与密码恢复、访问隔离、额度、示例和并发设置 |
| [部署与维护](docs/guides/deployment.md) | Ubuntu 安装、反向代理、应用发布、备份迁移和故障排查 |
| [贡献指南](CONTRIBUTING.md) | 项目结构、开发方式、测试命令和 Issue / PR 提交建议 |
| [转换引擎](https://github.com/cnzhhx/svg-transform-core) | Core 服务及其独立实现 |

## 部署到服务器

仓库提供 Ubuntu 首次安装脚本，安装 Node.js、pnpm、Docker 和 Nginx，构建应用并配置 systemd 服务。在服务器上克隆仓库后，从项目根目录执行：

```bash
sudo bash scripts/deploy-ubuntu.sh
```

默认访问 `http://服务器地址/transformer/`。模型配置保存在 `/etc/svg-to-html/model-provider.json`，应用环境保存在 `/etc/svg-to-html/app.env`；模板中的占位值需要替换。该安装脚本会配置系统服务与 Nginx，已有站点请先查看[部署与维护](docs/guides/deployment.md)。

后续应用发布使用 `pnpm publish:app`，由部署者提供目标服务器、目录和 URL。发布包含暂存验证、备份、失败回滚和活动任务检查；具体步骤见[应用代码发布](docs/guides/deployment.md#应用代码发布)。

## 常见问题

**支持 PNG、Figma 链接或 PDF 吗？**

当前上传入口接收 SVG 文件。其他设计工具中的页面请先导出为 SVG。

**启动页面需要模型密钥吗？**

页面可以在占位配置下启动，真实转换需要有效的模型配置和可用的 Core。模型凭据保留在服务端。

**转换速度和效果有保证吗？**

耗时和视觉差异受设计复杂度、模型能力、上游服务与排队情况影响。页面等待时间是估算值，示例中的差异数值也不是所有任务的保证。

**站点额度和并发在哪里改？**

在管理员设置页修改。访问策略、额度和示例设置保存在网关；全站转换并发由支持相应接口的 Core 保存。详见[管理员指南](docs/guides/administration.md)。

**能直接开放给公网访客吗？**

请先配置 HTTPS、入口限流和备份，并阅读[预览脚本的信任边界](docs/guides/deployment.md#预览与访问安全)。匿名浏览器身份不等同于正式用户账号，生成页面中的脚本也需要按受信任代码处理。

## 参与贡献

欢迎通过 [Issues](https://github.com/cnzhhx/svg-to-html/issues) 反馈问题、讨论需求，通过 Pull Request 改进代码、文档和示例。提交前请阅读[贡献指南](CONTRIBUTING.md)。

## 许可证

本仓库使用 [MIT License](LICENSE)。使用或分发时请保留版权和许可声明；独立 Core 与第三方依赖的许可请查看各自项目。
