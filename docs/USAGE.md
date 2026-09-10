# DSH 使用命令速查

> 本文档只记录**命令与目录结构**,不依赖具体版本号——版本更新后命令不变,可直接沿用。
> 三个入口:dsh CLI(框架本体)、`~/.dsh/update-dsh.mjs`(自装更新工具)、`~/.dsh/dsh-remote/`(多服务器管理器)。

---

## 1. 日常启动

```sh
dsh web                          # 启动 Web GUI(默认端口 3080)= dsh --profile web
dsh web --port 8080              # 换端口(web 应用自己的 flag 跟在后面)
dsh web --no-open                # 启动但不自动打开浏览器
dsh web --help                   # 看 web 应用的全部 flag(--host / --port / --trusted-host ...)
dsh --profile headless "跑一下测试"  # 无界面模式:跑一个持久会话,打印最终答案后退出
dsh --profile <名字>              # 启动自定义 profile(--profile 必须显式指定,web 是唯一别名)
dsh --profile web --patch ./x.yml  # 额外叠加一个 patch 覆盖层(可重复)
```

- 未把 `~/.dsh/bin` 加入 PATH 时,用绝对路径启动:`~/.dsh/bin/dsh web`
- 启动器的 flag 必须写在最前面;第一个不认识的 token 之后全部交给应用(如 `--port`、`--resume`)

## 2. 数据都在哪(升级安全区)

| 路径 | 内容 | 更新会不会动 |
|---|---|---|
| `~/.dsh/sessions/` | 会话日志(append-only JSONL.zstd,按工作目录分组) | **不碰** |
| `~/.dsh/settings.yaml` | 界面/模型等设置 | 只备份复制 |
| `~/.dsh/.credentials.yaml` | 凭据 | 不碰 |
| `~/.dsh/profiles/<name>/` | 插件依赖 + `cordis.patch.yml` + `package.json` | 只备份复制 |
| `~/.dsh/storages/` | 派生缓存(projcache 等,可自动重建) | 不碰 |
| `~/.dsh/harness/` | 受管安装(`<版本>/` + `current` 链接)——**更新工具专用,勿手改** | 更新工具专用区 |
| `~/.dsh/backups/` | 更新前的配置备份(按时间戳) | 更新工具写入 |

**配置层叠顺序**(从上到下优先级递增):
bundle 层 → profile 的 `cordis.patch.yml` → home 级 `~/.dsh/cordis.patch.yml` → `--patch` 覆盖层

## 3. 插件管理(`dsh plugin` = 转发给 pnpm)

```sh
dsh plugin --profile web add <包名>            # 安装插件(= pnpm add)
dsh plugin --profile web remove <包名>         # 卸载
dsh plugin --profile web update                # 更新插件依赖
dsh plugin --profile <名字> <任意 pnpm 命令>    # 通用转发
```

- 插件 = 在 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包
- 装进 `~/.dsh/profiles/<名字>/node_modules`,更新后按"已安装状态"自动对账 bundles 列表
- 相对路径参数以你**当前所在目录**为基准解析(如 `add ../my-plugin`)

## 4. 配置检查(升级前后对比用)

```sh
dsh web --dump-config            # 打印组合后的完整配置树(含用户层),不启动
dsh web --dump-default-config    # 只打印 bundle 层(不含用户覆盖)
dsh --profile <名字> --dump-config
```

- dump 与启动用同一套 patch 算法,结果就是启动时的真实内容
- 升级前 `dsh web --dump-config > before.yml`,升级后 diff,条目 id 消失 = 你的 user patch 会失效

## 5. 版本更新(update-dsh.mjs)

```sh
node ~/.dsh/update-dsh.mjs status          # 当前 vs 最新版本 + 升级路径
node ~/.dsh/update-dsh.mjs check           # 检查 + GitHub 发布说明
node ~/.dsh/update-dsh.mjs update          # 完整升级:备份→预取→冒烟→diff→确认→切换
node ~/.dsh/update-dsh.mjs rollback        # 回滚到上一版本
node ~/.dsh/update-dsh.mjs versions        # 列出已装版本
node ~/.dsh/update-dsh.mjs install <版本>   # 只预取不切换
node ~/.dsh/update-dsh.mjs prune [--keep N] # 清理旧版本(保留 current + 回滚目标 + 最近 N-1 个,默认 N=2)
```

常用参数:`--to <版本>` 指定目标;`--channel <tag>` 换通道(默认 `latest`;`status`/`check` 会显示全部 dist-tag 如 `alpha`,`update --channel alpha` 即可更新到 alpha 版本);`--yes` 非交互直接确认;`--force` 冒烟失败也切;`--no-path` 不写 PATH;`--home <目录>` / `$DSH_HOME` 换家目录。

**升级后要做的事(清单)**:
1. 重启 GUI:`~/.dsh/bin/dsh web`(运行中的旧进程不受影响,重启才切新版本)
2. 确认历史会话都在侧边栏(会话格式 v0 前后兼容,自动读旧记录)
3. sim 服务器(3081/3082)重启后自动用新版本(dsh-remote 已自动跟随 `harness/current`)
4. 远程服务器单独升级:`ssh <host> 'bash install-remote.sh --update'`
5. 若 `check` 提示某条目 id 消失 → 检查 `cordis.patch.yml` 里对应 patch

## 6. dsh-remote 多服务器管理

```sh
node ~/.dsh/dsh-remote/cli.mjs list              # 列出所有服务器
node ~/.dsh/dsh-remote/cli.mjs connect <名字>     # 建立 SSH 隧道(远程)或启动实例(direct)
node ~/.dsh/dsh-remote/cli.mjs connect --all      # 全部连接
node ~/.dsh/dsh-remote/cli.mjs open <名字>        # 浏览器打开该服务器 Web 窗口
node ~/.dsh/dsh-remote/cli.mjs status             # 检查隧道连通性
node ~/.dsh/dsh-remote/cli.mjs disconnect <名字>  # 关闭隧道
node ~/.dsh/dsh-remote/cli.mjs add                # 交互式添加服务器
node ~/.dsh/dsh-remote/panel.mjs [--port 4100]    # 浏览器控制面板
```

服务器端(在远程机上执行):
```sh
bash install-remote.sh [port]            # 首次安装并注册常驻服务(systemd/launchd/nohup)
bash install-remote.sh --update [port]   # 更新 dsh 到最新版并重启服务
```

本地常驻(面板 + 隧道自动恢复,登录即起,崩溃自愈):
```sh
bash ~/.dsh/dsh-remote/install-supervisor.sh install     # 安装(launchd,开机自启)
bash ~/.dsh/dsh-remote/install-supervisor.sh status      # 查看状态
bash ~/.dsh/dsh-remote/install-supervisor.sh uninstall   # 卸载
日志: ~/.dsh-remote-logs/{supervisor,panel,connect}.log
```

- 配置:`~/.dsh/dsh-remote/servers.json`(可用 `DSH_REMOTE_CONFIG` 换);模拟服务器 `servers.sim.json`
- direct 模式(direct: true)在本机起实例,`DSH_HOME` 指向各自 `sim-homes/<名>`;dsh 二进制优先用 `DSH_BIN`,否则自动跟随 `~/.dsh/harness/current`

## 7. 科研技能库(自用)

技能 = `~/.dsh/skills/<名字>/SKILL.md`(YAML frontmatter:`name`/`description` 必填,可选 `whenToUse`/`user-invocable`),**标准预设已自动挂载,写完实时生效,无需重启**。

```sh
ls ~/.dsh/skills/            # 现有技能(aiops-primer/paper-reading/idea-feasibility/
                             #  experiment-design/result-analysis/paper-writing)
```

- 模型会在任务匹配技能描述时自动加载技能正文;你也可以在对话里点名要求用某个技能
- 技能正文是 markdown 指令,可引用同目录 `references/` `scripts/` `assets/` 下的资源
- 加新技能 = 新建目录 + 写 SKILL.md;改技能 = 直接改文件,watch 实时刷新

## 8. 迁移(换机器 / 上服务器)

```sh
node ~/.dsh/migrate-dsh.mjs pack [--out <文件>] [--exclude-sessions] [--exclude-credentials]
node ~/.dsh/migrate-dsh.mjs list <归档>                      # 还原前预览
node ~/.dsh/migrate-dsh.mjs restore <归档> [--home <目录>]   # 新机器还原
```

- pack 打包数据/配置/插件/dsh-remote/工具,引擎只记录版本号(还原时重装,跨 OS 安全)
- 归档含凭据与私密会话(0600),分享时加 `--exclude-credentials` / `--exclude-sessions`
- 还原自动重写绝对路径(sim-homes)、重装引擎、写 state、冒烟验证配置
- 常用:`--engine <版本>` 指定引擎版本,`--no-engine` 只还原数据,`--force` 覆盖已有 home

## 9. 环境变量
|---|---|
| `DSH_HOME` | 家目录,默认 `~/.dsh`(dsh 与 update-dsh.mjs 都认) |
| `DSH_BIN` | dsh-remote direct 模式指定 dsh 二进制 |
| `DSH_REMOTE_CONFIG` | dsh-remote 配置文件路径(默认 `servers.json`) |
| `DSH_INSTALL_DIR` | install-remote.sh 的安装目录(默认 `~/.dsh-remote-install`) |

## 10. 故障排查速查

| 现象 | 处理 |
|---|---|
| 升级后某条 patch 被跳过并警告 | 该条目 id 在新版本消失;`dsh web --dump-config` 对比,改 patch |
| 启动失败 | stderr 有精确诊断(`assertEntriesActivated` 会列出失败的插件与缺失服务) |
| npm 报 EPERM / root-owned | 更新工具自动换独立缓存;根治:`sudo chown -R $(id -u):$(id -g) ~/.npm` |
| 更新后想退回 | `node ~/.dsh/update-dsh.mjs rollback` |
| 远程服务器版本落后 | `ssh <host> 'bash install-remote.sh --update'` |
| 界面数据"消失" | 不会——数据在 `~/.dsh/sessions/`,升级不碰;重启前先把输入框草稿发出去 |
