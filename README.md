# dsh-toolkit

[English](README.en.md)

| 项目 | 说明 |
|---|---|
| `tools/update-dsh.mjs` | 版本更新管控:受管安装、备份、冒烟、配置 diff、回滚、多通道、清理旧版本 |
| `tools/migrate-dsh.mjs` | 整套打包与还原:数据、配置、插件、远程清单 |
| `dsh-remote/` | 多服务器远程面板:隧道/本机直启两种模式,Web 面板 + launchd 常驻 |
| `plugins/dsh-plugin-amend/` | 插件示例:用 surface-replace 修改历史消息,日志保持 append-only |
| `skills/gpu-partition/` | 远程 GPU 工作分区模板(ssh/rsync) |

改造记录(验证情况、走不通的尝试)见 [CHANGELOG.md](CHANGELOG.md)。

## 环境

macOS(Apple Silicon)、Node 22+、零依赖(仅 Node 内置模块)

## License

MIT
