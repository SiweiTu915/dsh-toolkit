# dsh-toolkit

[English](README.en.md)

| 项目 | 说明 |
|---|---|
| `tools/update-dsh.mjs` | 版本更新管控:受管安装、备份、冒烟、配置 diff、回滚、多通道、清理旧版本 |
| `tools/migrate-dsh.mjs` | 整套打包与还原:数据、配置、插件、远程清单 |
| `dsh-remote/` | 多服务器远程面板:隧道/本机直启两种模式,Web 面板 + launchd 常驻;`workbench.mjs` 一键建「远程挂载工作台」;`rw.mjs` 不经本地副本直接增删改查远程文件 |
| `plugins/dsh-{fs,subprocess,bash,directory-picker}-sftp/` | 把执行世界整体搬到远程:三个接缝各一个 provider,使 `read`/`write`/`edit`、`bash`、`glob`/`grep` 与「Add workspace」全部落在远程机器上,本机只留 0 字节挂载点 |
| `plugins/dsh-plugin-amend/` | 插件示例:用 surface-replace 修改历史消息,日志保持 append-only |
| `plugins/dsh-remote-ui/` | 客户端插件示例:侧边栏 + 右侧抽屉的远程文件浏览器(0.1.5 起官方右侧栏文件树走同一 `ctx.fs` 接缝,已覆盖此用途,留作示例) |
| `skills/gpu-partition/` | 远程 GPU 工作分区模板(挂载型 + rw.mjs 两种用法) |

改造记录(验证情况、走不通的尝试)见 [CHANGELOG.md](CHANGELOG.md)。

## 环境

macOS(Apple Silicon)、Node 22+、零依赖(仅 Node 内置模块)

## License

MIT
