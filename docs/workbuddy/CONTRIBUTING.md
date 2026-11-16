# 参与 WorkBuddy RSI

本项目独立维护 WorkBuddy 插件、发行包、验证工具及文档。日常开发基于 `main`；提交改进时，新建功能分支并向本仓库发起 Pull Request。

## 本地检查

```sh
npm test
npm run benchmark:workbuddy
npm run build:workbuddy
```

运行时与自动回归仅依赖 Node.js 22+ 标准库，不需要安装根目录中为原引擎宿主测试保留的开发依赖。跨平台 CI 检查 Windows、Ubuntu、macOS 与 Node 22、24。

PR 应说明具体问题、修复后的行为和验证范围。Hook 协议及本地辅助进程的测试不能代替真实模型任务评估；提交性能或效果变化时，请附原始数据、对照条件和复现命令。

## 发行约定

修改插件中打包的文件后，同步提升根 package、WorkBuddy package、插件清单、Skill 与 CLI 显示版本。WorkBuddy 对相同版本可能复用旧缓存，安装器会逐文件核对 SHA256 并拒绝陈旧副本。

正式构建后再验证原生安装。每台机器的安装记录放在 `docs/workbuddy-user-install.json`，不打包进插件，避免安装记录改变被验证的发行包。

不要提交个人 RSI 状态、对话、凭据或任务内容。保留复用组件的 MIT 许可证和 NOTICE；来源说明见主页的致谢。
