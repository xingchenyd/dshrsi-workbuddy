# 独立展示与向上游贡献

本仓库：[xingchenyd/dshrsi-workbuddy](https://github.com/xingchenyd/dshrsi-workbuddy)。上游：[qybaihe/dshrsi](https://github.com/qybaihe/dshrsi)。基础提交 `c83c10c092215f6709c75be4846425b5157a6d48`。

这里采用 GitHub fork：拥有独立页面、发行包、CI 和贡献记录，同时保留上游关系。详见 [GitHub fork 官方说明](https://docs.github.com/en/pull-requests/reference/forks)。WorkBuddy 展示分支为 `codex/workbuddy-rsi`；fork 中的 `main` 保留上游基线。

本次交付不向原作者仓库推送、不改变其默认分支、不自动合并，也不自动向作者发送消息。后续有两种回馈方式：

1. **通用修复 PR**：已经单独发布 [codex/upstream-command-escape](https://github.com/xingchenyd/dshrsi-workbuddy/tree/codex/upstream-command-escape)，只含程序名正则修复及六项测试。可对照最新上游后提 PR，由原作者审核决定合并。该分支测试位于 `test/workbuddy/signature.test.mjs`，可直接用 `node --test test/workbuddy/signature.test.mjs` 执行；正式向上游提交时宜移入其 `test/unit` 默认测试集。
2. **适配功能 PR**：先协商是否希望上游同时维护 WorkBuddy，再将适配作为独立 package 提 PR。本 fork 的安装、说明和 Release 可以继续独立维护。

发 PR 时解释具体失败、修复后行为和验证命令；不要把 WorkBuddy 未运行的模型评估写成结果，也不要把原项目 benchmark 当成适配成绩。保留原版权通知，新增贡献以实际提交记录体现。

## 通用修复 PR 草稿

Title: Fix command matching for executable names containing regex characters

`commandPositionSource()` used a corrupted replacement string when escaping executable names. Programs such as `python3.13`, `foo.exe` and `clang++` could produce an invalid regex or incorrect matches. Restore literal escaping and cover exact command positions, discovery commands, suffix mismatches and masked exit-zero failures.

Validation: upstream unit tests and six focused regression cases. No WorkBuddy integration is required for this fix.
