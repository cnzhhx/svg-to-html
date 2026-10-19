# 贡献指南

[返回首页](README.md) · [English](CONTRIBUTING.en.md)

欢迎修复问题、完善文档、补充可公开的转换样本，或讨论新的交互和功能。较大的改动建议先开 Issue，说明使用场景和预期行为。

## 项目结构

```text
svg-to-html/
├── frontend/src/             # React + TypeScript 工作区与管理页面
│   ├── api/                  # 网关请求与事件流
│   ├── components/           # 上传、结果对比、聊天及管理组件
│   ├── state/                # 应用状态
│   └── utils/                # 产物、缓存与展示工具
├── backend/
│   ├── src/access/           # 匿名归属、管理员认证与产物访问
│   ├── src/core-service/     # Core 客户端与响应适配
│   ├── src/routes/           # 网关 API
│   ├── src/settings/         # 持久化运营策略
│   ├── config/               # 模型配置模板；真实配置不提交
│   └── tests/                # 使用模拟 Core 的测试
├── scripts/                  # 本地开发、部署、发布与回滚脚本
├── docs/guides/              # 中英文使用与部署指南
├── example/                  # 可公开的效果对比样本
└── .env.example              # 环境变量模板
```

网关使用 Express，前端使用 React 和 Vite。转换引擎在独立的 [svg-transform-core](https://github.com/cnzhhx/svg-transform-core) 项目中维护；本仓库通过 Docker 和 Core 客户端接入。

## 本地开发

按 [README 快速开始](README.md#快速开始)安装依赖、填写配置，再运行 `pnpm dev`。首次启动会准备缺失配置并启动 Core；配置、镜像或运行参数不一致时，启动脚本可能重建已有 Core 容器。

### 连接已有 Core

如果已有需要保留的 Core，先在 `.env` 中设置正确的 `SVG_TRANSFORM_CORE_URL` 和模型配置路径，然后分别启动应用开发服务：

```bash
# 终端一：网关
pnpm -C backend dev
```

```bash
# 终端二：前端
pnpm dev:frontend
```

这两个命令不管理 Core 容器。开发前端将 `/transformer/api` 转发到网关。修改 `PORT` 后应保持前端代理与网关一致，详见[配置指南](docs/guides/configuration.md#环境变量)。

### 常用检查

从仓库根目录运行：

```bash
pnpm test              # 发布回滚及网关测试，使用模拟 Core
pnpm build             # 构建前端并检查网关类型
pnpm lint:frontend     # 前端 TypeScript 检查
pnpm audit             # 可选：依赖安全审计
pnpm doctor            # 可选：本机依赖、配置与 Core 健康检查
```

测试不需要真实模型密钥，也不会提交付费转换。涉及访问控制、设置或管理员行为的修改，应通过前三项检查。文档修改应核对链接、命令、配置名称及中英文对应内容；命令示例不应指向个人部署地址。

测试涵盖运营设置持久化与版本冲突、写盘失败、管理员迁移和恢复、额度与跨日退款、权限矩阵、活动流撤销、路径穿越、预览策略和发布数据保留。

可选浏览器安全验证需要本机 Chrome 和 Playwright。将 `ARTIFACT_TEST_PLAYWRIGHT_PATH` 设置为 Playwright 的 `index.mjs` 绝对路径，再运行 `pnpm test`。浏览器测试必须使用隔离上下文和临时运行目录，不使用或重置个人浏览器资料。

## 提交 Issue

说明复现步骤、预期和实际结果，以及操作系统、Node.js、pnpm、Core 镜像版本和所选输出格式。附上必要日志或最小 SVG 样本前，先移除模型密钥、Cookie、管理码、个人部署信息和不应公开的设计内容。

涉及认证绕过或敏感数据泄露时，公开 Issue 只描述影响范围，不附真实凭据、运行账本或可直接利用的生产细节。

## 提交 Pull Request

- 将一次改动聚焦在一个问题上，说明触发条件、改动后的行为和验证结果。
- 界面改动可附前后截图，文档改动同时维护对应英文版本。
- 保留现有工作、本地配置和运行数据，避免把独立 Core 或旧应用目录混入无关改动。
- 不提交 `.env`、真实模型文件、`workspace/`、状态账本或其他运行数据；`docs/` 中的本地规划笔记也不作为公开文档提交。
- 不把发布或部署作为完成本地实现的默认步骤。网站发布流程见[部署指南](docs/guides/deployment.md#应用代码发布)。

提交代码或文档时，请保留 [MIT 许可证](LICENSE)及现有版权声明。
