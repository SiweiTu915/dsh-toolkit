# dsh-toolkit

我自己用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)时攒下来的一些工具、插件和技能。

不是框架,也不是给别人用的产品——就是我在自己机器上折腾 dsh 的过程里,把反复要用的东西慢慢整理成了脚本,顺手放上来。**自用为主,按需自取;不保证通用,也不提供支持。**

[English](README.en.md)

## 为什么会有这些

dsh 还在 rc/alpha 阶段,升个版本容易踩坑,换台机器又要重新配一遍。于是挨个补上了我最需要的几件事:

- **`tools/update-dsh.mjs`** —— 升级不再靠运气:先备份,再预取新版本,冒烟跑一遍,对比一下配置 diff,确认了才切换;不满意一条命令回滚。顺便支持了 `alpha` 这类通道,以及清理旧版本。
- **`tools/migrate-dsh.mjs`** —— 换机器/上服务器时,把会话、设置、插件、远程清单整个打包带走,到新机器一键还原。
- **`dsh-remote/`** —— 手上不止一台机器,想让每台都是一个独立工作台,从一个面板统一连、开、看状态。
- **`plugins/dsh-plugin-amend/`** —— 有时候想改历史对话里的一句话,又不想破坏 append-only 的日志,就拿 compaction 那套 surface-replace 机制试了一个。
- **`skills/gpu-partition/`** —— 远程 GPU 机器只当算力用,让本机 agent 自己 ssh/rsync 把活干了;这个是从我自己那套改出来的模板。

## 目录

| 路径 | 是什么 |
|---|---|
| `tools/update-dsh.mjs` | 版本更新管控(受管安装 / 更新 / 回滚 / 清理旧版本) |
| `tools/migrate-dsh.mjs` | 整套工作台打包与还原 |
| `dsh-remote/` | 多服务器远程面板(SSH 隧道 或 本机直启;带 Web 面板与常驻服务) |
| `plugins/dsh-plugin-amend/` | 插件示例:修改历史消息(日志保持 append-only) |
| `skills/gpu-partition/` | 远程 GPU 工作分区模板(ssh/rsync) |
| `docs/USAGE.md` | 命令速查,版本升级后基本还能用 |

## 怎么用

需要 **Node 22+** 和一个能跑的 `dsh`。

```sh
git clone <this-repo> && cd dsh-toolkit

node tools/update-dsh.mjs status     # 看看现在是哪个版本、有哪些通道
node tools/update-dsh.mjs update     # 备份→预取→冒烟→diff→确认→切换
node tools/update-dsh.mjs rollback   # 出问题就回滚

node tools/migrate-dsh.mjs pack              # 打包(得到 dsh-migrate-*.tar.gz)
node tools/migrate-dsh.mjs restore <归档>     # 在目标机器还原
```

远程面板(可选装成常驻):

```sh
bash dsh-remote/install-supervisor.sh install
node dsh-remote/cli.mjs list / connect <名字> / open <名字>
```

技能:把 `skills/*` 拷到 `$DSH_HOME/skills/`(默认 `~/.dsh/skills/`)就会被自动发现,不用改配置。

插件:

```sh
cd ~/.dsh && dsh plugin --profile web add <本仓库路径>/plugins/dsh-plugin-amend
```

## 一些实话

- 我在 **macOS(Apple Silicon)** 上用的,工具只在 macOS/Linux 试过,Windows 没测
- 全部零依赖,只用 Node 内置模块;远程面板也只用 ssh/rsync 和系统自带的东西
- **dsh 还在快速迭代**,上游一变这些东西可能就得跟着改;我按自己的需要修,不承诺兼容
- 有些坑我踩过并记在下面,省得你重踩:
  - `dsh-plugin-amend` 目前只支持**替换消息文本**(删除/恢复没做);UI 上显示修改还需要客户端 Definition
  - `dsh-remote` 的隧道模式**必须免密 SSH**——后台连接没法输密码
  - 在 **macOS 26 + Apple Silicon** 上想把远程目录做成**真·系统挂载**(WebDAV / SMB / FUSE-T)基本走不通(系统限制 + 上游 bug),别在这上面浪费时间,看远程文件直接用 VS Code Remote-SSH

## License

MIT,随便用 —— 见 [LICENSE](LICENSE)
