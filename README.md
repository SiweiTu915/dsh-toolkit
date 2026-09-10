# dsh-toolkit

围绕 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)的一组实用工具、插件与技能:让 dsh 这个 agent 框架**可升级、可迁移、可远程、可领域定制**。

中文 | [English](README.en.md)

> DSH 本身是上游维护的引擎;这个仓库是围绕它的**用户侧工程层**——补上框架暂未提供的能力(升级管控、整体迁移、多机远程管理、历史消息修改、远程算力使用模板)。
>
> **这个仓库专门用于长期维护我对 DSH 所做的改造与升级**;新能力一律按下方[维护指南](docs/MAINTAINING.md)的结构加进来。

## 组件

| 组件 | 作用 |
|---|---|
| [`tools/update-dsh.mjs`](tools/update-dsh.mjs) | **版本更新管控**:受管安装(不依赖 npx 缓存)、备份 → 预取 → 冒烟 → 配置 diff → 切换 → 可回滚;支持多通道(latest/next/alpha)、`prune` 清理旧版本 |
| [`tools/migrate-dsh.mjs`](tools/migrate-dsh.mjs) | **整套迁移**:把数据/配置/插件/远程清单打包成一个归档,新机器一键还原(自动重写绝对路径、重装引擎、冒烟验证) |
| [`dsh-remote/`](dsh-remote/) | **多服务器远程面板**:把每台服务器/分区管成一个独立 dsh 工作台;SSH 隧道 / 本机直启两种模式,带 Web 控制面板与本地常驻(supervisor) |
| [`plugins/dsh-plugin-amend/`](plugins/dsh-plugin-amend/) | **示例插件**:修改历史对话(用 compaction 同款 surface-replace 机制,日志保持 append-only) |
| [`skills/gpu-partition`](skills/gpu-partition/) | **远程 GPU 工作分区模板**:让本机 agent 通过 ssh/rsync 读写远程文件、跑训练、取结果(含 SSH 别名与免密接入步骤) |
| [`docs/USAGE.md`](docs/USAGE.md) | 命令速查(版本无关,升级后仍适用) |

## 快速开始

需要 **Node 22+** 与一个可用的 `dsh`。

```sh
git clone <this-repo> && cd dsh-toolkit

# 1) 版本更新管控
node tools/update-dsh.mjs status     # 看当前/最新版本与各 dist-tag
node tools/update-dsh.mjs update     # 备份→预取→冒烟→diff→确认→切换
node tools/update-dsh.mjs rollback   # 一键回滚

# 2) 迁移(换机器 / 上服务器)
node tools/migrate-dsh.mjs pack      # 打包 → 得到 dsh-migrate-*.tar.gz
node tools/migrate-dsh.mjs restore <归档>   # 在目标机器还原

# 3) 远程面板(可选:本地常驻)
bash dsh-remote/install-supervisor.sh install
node dsh-remote/cli.mjs list / connect <名字> / open <名字>
```

技能:把 `skills/*` 拷到 `$DSH_HOME/skills/`(默认 `~/.dsh/skills/`)即被自动发现(标准 agent 预设已挂载 skill 提供者,无需改配置)。

插件:

```sh
cd ~/.dsh && dsh plugin --profile web add <本仓库路径>/plugins/dsh-plugin-amend
```

## 设计原则

- **引擎与用户层分离**:框架本质交给上游;这里只做用户侧能力,不 fork、不改核心
- **数据优先**:会话/配置/插件是纯文件,升级与迁移都不动它们(升级前自动备份、可回滚)
- **一切先验证再切换**:升级/迁移都带冒烟测试与配置 diff,失败不切换
- **零依赖**:工具全部只用 Node 内置模块;远程面板只用 ssh/rsync 与系统自带能力

## 已知限制

- 工具面向 macOS/Linux(Windows 未验证)
- `dsh-plugin-amend` 只支持替换消息文本(删除/恢复未实现);UI 层显示修改需要客户端 Definition(见该插件 README)
- `dsh-remote` 的隧道模式要求免密 SSH(非交互后台连接无法输入密码)
- macOS 26(Apple Silicon)上把远程目录做**真·系统挂载**(WebDAV/SMB/FUSE-T)存在系统限制与上游 bug,本仓库不提供挂载方案;远程文件浏览建议用 VS Code Remote-SSH

## 许可证

MIT(见 [LICENSE](LICENSE))
