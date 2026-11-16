# 验证记录

日期：2026-11-16。此文区分实际执行检查与尚未证明的效果。

| 检查 | 结果与范围 |
| --- | --- |
| 原 DSHRSI 单元回归 | Windows / Node 22.17.0：148/148 通过 |
| 新增 WorkBuddy 回归 | 工具协议、真实 Hook 子进程、本地 IPC、状态持久化、提案验证、权限、安装器、发布包；最终完整套件 188/188 通过（含上游 148 项） |
| 原生清单校验 | 当前 WorkBuddy 桌面所带 CLI 2.176.0 接受 marketplace 及 plugin manifest |
| 原生隔离安装 | Node 24.22.3 首装与重复安装通过；Node 22.17.0 全新隔离目录安装通过 |
| 安装幂等 | 重复安装后同一插件仅一个版本目录，原生查询显示 0.1.0、user、enabled:true |
| 隔离边界 | 隔离安装检查前后，真实用户 WorkBuddy settings.json 哈希一致 |
| Windows 中文路径 | 构建与安装通过；构建避开本机 Node 22.17 fs.cpSync 的原生崩溃，改为显式目录复制 |
| WorkBuddy 真实模型任务 | 未执行；没有据此声称实际模型任务成功率或性能提高 |
| 原 DeepSeek Harness E2E / benchmark | 本次未执行，不把上游报告当作 WorkBuddy 测试结果 |

本机用户范围安装已完成，原生查询显示 `workbuddy-rsi@dshrsi-workbuddy` 为 `0.1.0`、`user`、`enabled:true`。安装前后对设置的比较只发现三个预期新增项：本插件启用项、本插件市场登记、本插件安装登记。最终完整测试计数见 `verification.json`。GitHub Actions 配置为 Windows、Ubuntu、macOS × Node 22、24；运行结果以 [当前 Actions 页面](https://github.com/xingchenyd/dshrsi-workbuddy/actions/workflows/workbuddy.yml) 为准，配置矩阵本身不等于通过。

## 自动测试的证据边界

Hook 事件载荷使用可控测试数据。Node 进程、HTTP IPC、原引擎、验证关卡及持久化读写真实执行，不调用模型。覆盖重复错误学习、后续会话拦截、成功调用不受干扰、双回调去重、有限 Stop 续跑、关闭与撤销、重启后的库保留、工作区限制、未经授权 IPC 拒绝、并发启动、异常和超大输入。

提案测试证明传入者不能替换 daemon 观察证据，成功历史会参与回归；不支持的能力不会运行，批准前重新验证。它不证明任意模型生成代码都正确，也不证明上游 VM 是恶意代码隔离边界。

原生安装测试使用桌面所带 `codebuddy-lite-wb.mjs`，环境设为 `CODEBUDDY_HOST=workbuddy-desktop` 和隔离配置目录。验证器和插件管理器实际解析文件、建立注册、返回启用状态；没有把它称为完成了桌面 UI 中的模型任务。

## 复现

```powershell
npm test
npm run build:workbuddy
npm run install:workbuddy -- --config-dir "C:\temp\wb-rsi-validation"
```

macOS/Linux 的安装验证需要相应平台的 WorkBuddy 桌面应用；GitHub CI 只运行无模型的单元、协议、进程、安装器模拟及分发包检查，不会安装腾讯桌面应用。

本机原生 Bash/PowerShell 返回形态已从随应用安装的 CLI 源码核对，覆盖 exitCode、interrupted、signal、sandboxDenied。当前 PowerShell rawResponse 不含 stderr/error 正文，因此能识别失败与重复失败，但具体缺失程序诊断可能受限。
