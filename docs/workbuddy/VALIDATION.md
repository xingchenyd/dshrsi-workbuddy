# 验证记录

日期：2026-11-16。当前发布：0.2.0。本页区分自动回归、受控机制对照、原生安装及真实模型任务。

| 检查 | 结果与范围 |
| --- | --- |
| 本机完整回归 | Windows / Node 22.17.0：189/189 通过，包含原核心 148 项与 WorkBuddy 相关 41 项 |
| 受控机制对照 | 真实 OS 启动尝试与文件操作；固定 12 次缺失命令请求，OFF 失败 12 次、ON 失败 5 次 / 拒绝 7 次；正常命令两组均 4/4 成功 |
| 持久化对照 | 重建 host 并重读磁盘库后仍加载规则；计入学习阶段的全部失败为 OFF 8 次、ON 5 次；不等于重启桌面或系统进程 |
| 验证续跑对照 | 实际写入文件后 ON 要求验证；实际运行 node --check 成功后两组均允许结束 |
| 跨平台 CI | Windows、Ubuntu、macOS × Node 22、24；最新运行见下方链接及 verification.json |
| 原生安装 | Windows WorkBuddy 桌面内置 CLI 2.176.0；已验证首次、重复安装、版本升级及安装内容 SHA256 校验，当前用户安装版本详见独立安装记录 |
| Windows 中文路径 | 构建、安装和真实子进程回归覆盖 |
| 真实 WorkBuddy 模型任务 | 未执行；未测量实际任务成功率、耗时或 Token 收益 |

[机制实验方法与轨迹](benchmarks/README.md) · [原始实验 JSON](benchmarks/results.json) · [机器可读验证记录](verification.json) · [最新 CI](https://github.com/xingchenyd/dshrsi-workbuddy/actions/workflows/workbuddy.yml) · [当前用户安装核验](https://github.com/xingchenyd/dshrsi-workbuddy/blob/main/docs/workbuddy-user-install.json)

## 自动测试的范围

Hook 事件使用受控载荷，Node 进程、HTTP IPC、引擎、验证关卡和持久化读写真实执行。覆盖重复错误学习、后续会话拒绝、成功调用保护、双回调去重、有限 Stop 续跑、关闭与撤销、进程重启后保留改进、工作区限制、未经授权 IPC 拒绝、并发启动、异常和超大输入。

效果对照独立调用进程内 host，专门隔离工具执行边界的作用，未经过 daemon 网络传输。其真实缺失命令启动、正常命令和语法检查均由操作系统执行。固定驱动刻意重复提交相同请求，不代表模型决策，不应外推为通用生产力改善。

提案测试验证 daemon 自行取得观察证据，成功历史参与回归；不支持的能力被拒绝，批准前重新验证。它不证明任意模型生成代码都正确，也不证明 Node VM 能隔离恶意代码。

## 原生安装与分发

安装器通过桌面自带管理器解析清单、建立注册、查询启用状态，并逐文件比较 SHA256。对每台机器的安装核验放在插件包之外，避免记录本身改变被验证的包内容。

0.1.0 到 0.1.1 的原生隔离升级及重复安装已验证。同版本修改内容会复用旧缓存，此现象已复现；安装器会拒绝把旧缓存报告为新代码。新版发布前再次验证安装文件与 ZIP 一致，具体版本见独立安装记录。

macOS/Linux CI 运行无模型的单元、协议、子进程、安装器模拟和打包检查，没有安装腾讯桌面应用，因此不声称这些平台已完成真实桌面安装。

## 复现

```sh
npm test
npm run benchmark:workbuddy
npm run build:workbuddy
npm run install:workbuddy -- --config-dir "C:/temp/wb-rsi-validation"
```

受控实验无需安装 WorkBuddy。最后一条原生安装命令需要本机已安装 WorkBuddy 桌面应用。测试不会读取个人历史对话数据库。

## 历史记录

0.1.1 曾在六组 CI 上各通过 188 项测试，代码提交为 f829255e6333ba1e5eba42d4e590a29891701e10。[历史运行](https://github.com/xingchenyd/dshrsi-workbuddy-fork-backup-20261116/actions/runs/43827168315) 保存在归档备份中，不充当 0.2.0 的验证记录。

本机原生 Bash/PowerShell 返回形态已从应用安装包核对，覆盖 exitCode、interrupted、signal、sandboxDenied。当前 PowerShell rawResponse 不含 stderr/error 正文，因此能够识别失败与重复失败，但具体缺失程序诊断可能受限。原 DeepSeek Harness E2E / 模型 benchmark 本次未执行。
