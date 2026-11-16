# 安装、使用和卸载

## 从源码安装

安装 Node.js 22+，确保 WorkBuddy 启动环境能找到 `node`。在克隆的本项目中运行：

```powershell
npm test
npm run build:workbuddy
npm run install:workbuddy -- --dry-run
npm run install:workbuddy
```

不需要 `npm install`：WorkBuddy 适配和上游核心仅依赖 Node 标准库。根项目保留的开发依赖用于原 DeepSeek Harness 端到端测试，普通安装无需下载。

安装器定位桌面应用自带的 `cli/bin/codebuddy`，设置桌面运行模式，然后使用原生 `plugin validate`、`plugin marketplace add`、`plugin install`、`plugin list`。默认配置目录是 `~/.workbuddy`，不会自行拼写内部插件注册文件。

自动发现失败时，可指定桌面应用的 CLI 入口：

```powershell
npm run install:workbuddy -- --cli "C:\Users\YOUR_NAME\AppData\Local\Programs\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy"
```

只验证文件、不安装：`npm run install:workbuddy -- --validate-only`。

隔离安装测试：`npm run install:workbuddy -- --config-dir "C:\temp\wb-rsi-test"`。该目录是 WorkBuddy 插件注册测试目录；RSI 运行状态另由 `WB_RSI_HOME` 管理。

安装后保留源码目录和生成的 `dist/workbuddy-rsi-marketplace`，因为原生插件市场登记了这个本地来源。重新开启 WorkBuddy 会话，让新会话加载插件。管理技能与 `/rsi` 命令随完整插件一起分发。

## 使用发行包

下载 Release 的 `workbuddy-rsi-0.1.0.zip`，完整解压。包内包含自包含插件市场和 `install-workbuddy.mjs`。在解压目录执行：

```powershell
node install-workbuddy.mjs --marketplace ".\workbuddy-rsi-marketplace"
```

保留解压目录。不要只复制 SKILL.md：自动观察依赖同包内 hooks 和核心代码。当前发布不提供冒充自动插件的单 Skill 包。

## 查看和管理

源码目录：`npm run wb-rsi -- status`。发行包可运行：

```powershell
node ".\workbuddy-rsi-marketplace\plugins\workbuddy-rsi\packages\workbuddy-rsi\bin\rsi.mjs" status
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `status` | 查看启用状态、会话与改进列表 |
| `show ID` | 查看代码与验证报告 |
| `findings SESSION_ID` | 查看真实进行中会话证据 |
| `propose FILE SESSION_ID SIGNATURE` | 用该会话真实证据验证模型编写的候选代码 |
| `approve ID` | 启用通过验证的 proposal；新会话确保加载 |
| `disable ID` | 停用一条改进 |
| `undo` | 撤销最近改进状态变更 |
| `off` / `on` | 持久停用 / 恢复 RSI |
| `stop` | 关闭本地辅助进程；下次 hook 会重启 |

默认状态目录 `~/.workbuddy-rsi`。可用 `WB_RSI_HOME` 指定绝对路径，或为 CLI 传入 `--home`；测试时让 hook 和管理 CLI 使用同一目录。不要上传该目录，其中可能包含工作内容片段。

## 卸载

先执行 `off`，然后在 WorkBuddy 插件管理中禁用或卸载 `workbuddy-rsi`，再执行 `stop`。通过应用卸载，不直接编辑其 settings 或插件注册表。保留 `~/.workbuddy-rsi` 可保留已有改进记录；本项目不会自动删除它。

更新代码或重新构建后，重新执行安装器。当前正在运行的辅助进程仍可能使用旧代码；先 `stop` 再开启新会话，以加载更新版本。
