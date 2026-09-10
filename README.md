# dsh-toolkit

我对 DeepSeek Harness(`dsh`)所做改造的记录。非开源项目,自用留档。

[English](README.en.md)

| 项目 | 说明 |
|---|---|
| `tools/update-dsh.mjs` | 版本更新管控:受管安装、备份、冒烟、配置 diff、回滚、多通道、清理旧版本 |
| `tools/migrate-dsh.mjs` | 整套打包与还原:数据、配置、插件、远程清单 |
| `dsh-remote/` | 多服务器远程面板:隧道/本机直启两种模式,Web 面板 + launchd 常驻 |
| `plugins/dsh-plugin-amend/` | 插件示例:用 surface-replace 修改历史消息,日志保持 append-only |
| `skills/gpu-partition/` | 远程 GPU 工作分区模板(ssh/rsync) |

## 记录

- `update-dsh`:0.1.0-rc.6 → 0.1.1-rc.2 → 0.1.2-alpha.5 均走通(备份、配置 diff、冒烟、切换、回滚)
- `migrate-dsh`:打包 → 新 home 还原 → 重装引擎 → 真实启动,全流程验证
- `dsh-plugin-amend`:surface-replace 机制验证通过(表面层替换生效,原日志保持 append-only)
- `dsh-remote`:面板与实例已接 launchd 常驻;隧道模式要求免密 SSH;PID 复用导致的"假活"已修
- 走不通:macOS 26 + Apple Silicon 上把远程目录做真·系统挂载(WebDAV / SMB / FUSE-T 均受阻)

## 环境

macOS(Apple Silicon)、Node 22+、零依赖(仅 Node 内置模块)

## License

MIT
