# Reasoning-only tool call anomaly

## 背景

在对 session `bZnMbPbonG` 的 `module-01`、`module-02` 排查时，发现两个模块都出现了“执行一小段后停止”的现象。表面看模块状态为 `completed`，但实际产物仍接近初始化模板，后续 diff 表现较差。

相关模块：

- `workspace/sessions/bZnMbPbonG/artifacts/modules/module-01`
- `workspace/sessions/bZnMbPbonG/artifacts/modules/module-02`

## 观察结果

两个模块的 provider telemetry 均显示：

- `baseURL`: `http://llmapi.bilibili.co/v1`
- `provider`: `bitto`
- `model`: `kimi-k2.7-code`
- `exitCode`: `0`
- `retryCount`: `0`
- `errorBodies`: `[]`
- `errorMessages`: `[]`
- `httpStatusCodes`: `[]`

这说明它们不像是网络、HTTP、鉴权或上游硬错误导致的失败。

但 turn summary 同时显示：

- `textCharCount`: `0`
- `firstTextSample`: `null`
- `totalCommands`: `0`
- `totalShellCommands`: `0`
- `totalInternalRounds`: `0`

也就是说，agent 回合没有产生可见 assistant 文本，也没有产生被 runtime 识别并执行的工具调用。

## 关键异常

runtime trace 里可以看到模型把工具调用内容吐进了 `reasoning` 文本，而不是结构化 `tool_use` 事件。

例如 `module-01` 最后阶段出现了类似：

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.write:12...
```

但对应的 `functions.write:12` 没有成为真正的 `tool_use` 事件，因此 CSS 写入没有执行。

`module-02` 也出现了类似情况：

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.todowrite:8...
```

这个 todo 工具调用同样没有被 runtime 执行，随后 step 以 `reason: "stop"` 结束。

## 影响

由于模块目录在 agent 运行前已有初始化模板，`ensureRequiredOutputFiles` 仍可能通过文件存在性检查，导致 run 被标记为 `completed`。

实际产物质量不充分：

- `module-01` 只执行了部分写入，CSS 写入丢失。
- `module-02` 基本停留在空壳模板。
- `bZnMbPbonG` 最终整体 diff 为 `6.69%`，未稳定达到目标。

## 判断

这不是典型的大模型服务渠道“挂了”，更像是：

1. 模型或渠道把 tool call 按纯 reasoning 文本输出。
2. runtime 没有把这类文本解析成结构化工具调用。
3. pipeline 对“无正文、无工具调用、但进程正常退出”的回合缺少完成质量门禁。

因此可以认为它与模型服务渠道或模型 tool-call 兼容性有关，但不是 transport 层错误。

## 建议防线

后续可以增加以下 guard：

1. 如果 `reasoning` 中出现 `<|tool_calls_section_begin|>`、`<|tool_call_begin|>` 或 `functions.xxx`，但没有对应 `tool_use` 事件，应将本 turn 标记为异常结束。
2. 如果一个模块 turn 满足 `textCharCount === 0` 且 `totalCommands === 0`，不应直接视为有效完成。
3. 模块完成前增加非模板产物检查，例如 HTML/CSS 字节数、关键文件 hash 是否仍等于初始化模板。
4. 对模块 agent 强制要求至少满足以下任一条件：产生 assistant final text、执行过有效工具调用、产物相对初始化模板有实质变化、或完成一次有效 verify/browser_eval。
5. 如果同一渠道反复出现 reasoning-only tool call，可在 provider 层禁用该模型/渠道执行需要 tool call 的任务，或切换到结构化工具调用稳定的渠道。

