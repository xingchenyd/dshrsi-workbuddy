# WorkBuddy 适配设计

## 已核查的接入面

查询日期：2026-11-16。

- [WorkBuddy 桌面插件说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Plug-In)：插件支持 Skills、快捷指令与 Hooks。
- [WorkBuddy 技能开发规范](https://open.workbuddy.cn/docs/skill)：SKILL.md 及 scripts/references 结构。
- [WorkBuddy 更新日志](https://www.workbuddy.cn/docs/workbuddy/Changelog)：5.3.5 提及桌面扩展插件 Hook。
- [Hook 技术参考](https://www.workbuddy.cn/docs/cli/hooks)：此页属于 CodeBuddy Code。这里仅将其作为格式依据，另用桌面安装包验证相应事件的实际存在，不推定所有 CLI 功能都可用于桌面。
- [专家团插件结构](https://open.workbuddy.cn/docs/expert-team)：桌面生态采用相通的插件清单结构。

本机 WorkBuddy 桌面 5.11.3 所带 `@genie/agent-cli` 版本为 2.176.0。内置 `workbuddy-sheetagent` 插件具有 `hooks/hooks.json`，实际使用 `${CODEBUDDY_PLUGIN_ROOT}` 和 Node 脚本；另一个官方市场插件提供 SessionStart。桌面 bundle 中可核对本适配的七个事件、PreToolUse deny/ask 和 additionalContext 输出。

## 复用与新增

原 `packages/dsh-rsi/src` 是宿主无关引擎，采用 `createEngine({library, options, host})`。本版直接导入它，没有将 RSI 重新实现成一组提示词。

`packages/workbuddy-rsi/src/protocol.mjs` 将 Bash/PowerShell/Read/Write/Edit 及桌面别名转换为原引擎观察，统一退出码和错误标志。`host.mjs` 把事件送入原检测器，运行验证及挂载，再把结果映射回 WorkBuddy hook 输出。唯一上游源码修复是程序名正则转义错误，独立提交、独立回归覆盖，便于回馈上游。

Hook 脚本每次会启动新进程，而适配代码内部的计数器需要跨调用保存。因此增加一个本地辅助进程，通过 `127.0.0.1` 随机端口和 256-bit 本地 token 通信。请求串行执行、有大小和时间上限；没有外部监听地址，不需要 WorkBuddy 凭据。辅助进程空闲 30 分钟退出，下一次 hook 自动重启。

持久化库与原 DSH 数据隔离，默认 `~/.workbuddy-rsi`。重启保留已学改进，进行中会话证据和处理器计数重新开始。因此只承诺跨会话复用持久化改进，不承诺重启后无损恢复正在进行的推理。

## 两条生成路径

自动路径：真实工具事件 → 原检测器 → 原确定性模板 → 原五阶段验证 → 当前会话挂载。

当前模型路径：Skill 读取 live findings → WorkBuddy 模型写 JS → `propose` 指定真实 session/signature → daemon 自行取观察证据和成功历史 → 原五阶段验证 → proposed → 用户请求 `approve` → 新会话加载。调用者不能上传一份自造的“成功证据”跳过关卡。

模板路径是原项目的可运行降级方式；模型路径使用 WorkBuddy 当前模型的代码生成能力。这不同于原 DeepSeek Harness 在一次模型步骤里自动发起的同会话模型生成，不声称两者全等。

## 权限与失败处理

支持 prompt/annotate/steer/deny/ask/verify。block/rewrite/tool/exec 不能在当前接口下可靠保留原语义，故不开放。PreToolUse 从不返回 `allow`。Stop 尊重 `stop_hook_active`，每轮最多一次续跑，避免阻止任务结束的循环。

插件读取传入事件，不读取历史对话数据库或 `transcript_path` 文件，不修改 WorkBuddy 二进制。对命令、参数和输出尽力脱敏；这不是任意文本无敏感信息的保证。原 Node VM 仅防误用，不构成对恶意代码的强安全隔离。对本地自写代码的实际授权仍属于用户和宿主。

## 验证含义

自动回归检查工具事件、真实子进程与本地 IPC、状态持久化、验证拒绝、撤销等行为。桌面自带插件管理器验证检查清单和注册。二者都不等于真实 WorkBuddy 模型在长期任务中的收益；本项目不搬用原版 benchmark 作为适配效果。
