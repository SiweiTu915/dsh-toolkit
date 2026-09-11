# 改造台账

按时间记录对 DSH 做的改造、验证情况和踩到的死路。新条目往后追加,旧条目不改。

| 日期 | 项目 | 变更 | 验证 |
|---|---|---|---|
| 2026-08-22 | `tools/update-dsh.mjs` | 新增:受管安装(脱离 npx 缓存)、备份 → 预取 → 冒烟 → 配置 diff → 切换 → 回滚;支持多 dist-tag 通道 | 0.1.0-rc.6 → 0.1.1-rc.2 实跑通过(备份、diff、切换、回滚均验证) |
| 2026-08-22 | `tools/migrate-dsh.mjs` | 新增:整套工作台打包与还原(数据、配置、插件、远程清单),还原时重写绝对路径并重装引擎 | 全流程验证:打包 → 新 home 还原 → 引擎重装 → 真实启动成功 |
| 2026-08-22 | `plugins/dsh-plugin-amend` | 新增:用 compaction 同款 surface-replace 机制修改历史消息,日志保持 append-only | 表面层替换实测生效(`surface.nodes` 由 `[0,1]` 变为 `[0,3]`,原事件保持 append-origin) |
| 2026-08-25 | `dsh-remote/supervisor.sh` · `install-supervisor.sh` | 新增:launchd 常驻,登录自动恢复隧道/实例,面板崩溃自动拉起 | 杀死面板 5 秒内自动重启;sim 实例随启动恢复;修复 launchd 环境缺 node 的问题 |
| 2026-09-03 | 全量 | 引擎升级 0.1.1-rc.2 → 0.1.2-alpha.5(alpha 通道) | 配置 diff:消失 3 个 id(均为内部重构,未被 patch 引用)、新增 13 个;真实启动通过 |
| 2026-09-03 | `tools/update-dsh.mjs` | 新增 `prune` 子命令清理旧版本;`status`/`check` 改为显示全部 dist-tag(此前看不到 alpha 通道) | 实跑通过;prune 正确保护 current 与回滚目标 |
| 2026-09-03 | `dsh-remote/cli.mjs` · `panel.mjs` | 修复 PID 复用导致的"假活"(重启后旧 PID 被新进程占用,实例死了却显示在运行) | 存活判断改为 PID + 端口双确认;`disconnect` 对复用 PID 不再误杀;用真实过期记录验证 |
| 2026-09-03 | `skills/gpu-partition` | 新增:远程 GPU 工作分区模板(ssh 别名 + 免密接入 + rsync/远程执行规范) | 远程读写、rsync 干跑、真实读取项目目录均通过 |
| 2026-09-03 | 仓库 | 建立本仓库,整理工具/面板/插件/技能为留档 | 脱敏扫描通过(无服务器地址、凭据、个人路径) |
| 2026-09-10 | `plugins/dsh-fs-sftp` | 新增:`ctx.fs` 的 SFTP provider(继承 `FileSystem`,实现 11 个契约方法;原子写 = 同目录 staging + rename)。工作区注册表的本机校验是硬约束,用「本机空挂载点目录 + 前缀映射」绕过 | agent 用原生 `read`/`write` 直读直写远程文件,内容与独立 SFTP 读取逐字节一致;写入的文件出现在远程,本机挂载点始终 0 字节、0 文件 |
| 2026-09-10 | `plugins/dsh-subprocess-sftp` | 新增:继承 `LocalSubprocessRuntime`,**只覆盖 `spawn`**,把 argv/cwd 翻译成一条 ssh 调用(收集/spill/超时/终止全部复用官方实现)。一个 provider 同时解决两个工具:`bash`(因为 `LocalBashExecutor` 本身是 `ctx.subprocess` 的消费方)与 `glob`/`grep`(走 `ctx.subprocess.spawn([rgPath,…])`) | `uname -sr` 返回远程 Linux 内核(本机是 Darwin);glob 命中数与远程 `find` 一致;grep 在 9 个远程 `.py` 文件里命中 —— 这些文件本机不存在 |
| 2026-09-10 | `plugins/dsh-bash-sftp` | 新增:继承 `LocalBashExecutor`,只如实汇报 `sandboxMode = danger-full-access`(远程以 root 运行、本机不施加文件沙箱)并把默认 workdir 指向挂载点 | 不汇报则 `dsh-permission-presets` 在构造期直接抛错、整个组合启动失败;配套在 permission 预置表补一条 `(danger-full-access, ask)` 后正常启动 |
| 2026-09-10 | `plugins/dsh-directory-picker-sftp` | 新增:远程版目录选择器(`{kind:'browse', list, createDirectory}`)。列举远程目录时把每个目录在本机物化成空占位骨架,于是「Add workspace」选中的路径天然满足注册表的本机校验;新建文件夹同时在远程与本机建 | 列出远程 `/root` 下 24 个目录、面包屑显示 `server:/root › <数据盘>`;新建目录在远程与本机各建一份(远程已独立确认);重复建报 `directory-exists`、非法段名报 `directory-create-failed`;本机骨架 0 字节 0 文件 |
| 2026-09-10 | `dsh-remote/workbench.mjs` · `panel.mjs` · `panel.html` | 新增:面板一键建「远程挂载工作台」——建分区 home/profile → 装 4 个 provider → 写映射配置 → 建挂载点 → 继承凭证/设置/技能 → 注册清单 → 启动并验证存活;分步回报,失败自动回滚半成品 | HTTP 全流程 8 步全绿;新建出的工作台三接缝实测全部落在远程 |
| 2026-09-10 | `dsh-remote/panel.mjs` · `supervisor.sh` | 修复两处环境问题:①launchd 的 PATH 缺 `$HOME/.dsh/bin`,建工作台时报 `pnpm not found`;②direct 实例启动输出原为 `stdio:'ignore'`,实例崩溃无从排查,改为落 `.state/boot-<name>.log` | 补 PATH 后安装步骤通过;启动日志实测用于定位一次真实崩溃(端口开放 ≠ 启动成功,须确认进程存活) |
| 2026-09-11 | `plugins/dsh-fs-sftp` | 补 `readByteRange(target, {offset,length}, signal)`:0.1.5 起 fs 契约由 12 个抽象方法增至 13 个,新增此方法供工作区文件树/文档预览做分页读。语义对齐官方 `readByteWindow`(先确认常规文件;`length===0` 返回空;窗口越界返回空**不报错**) | 用远程 `head -c` / `dd` 的 md5 独立比对 3/3(含一个被文件末尾截断的窗口);边界(长度 0、越界、恰好末尾)全对;错误码为 `FS_NOT_REGULAR_FILE`/`FS_IO_ERROR`;并在 0.1.5 契约下复验 |
| 2026-09-11 | 全量 · 引擎升级 | 0.1.2-rc.1 → 0.1.5-rc.2。该版本新增右侧栏 + 工作区文件树 + 文档预览 + 外部打开(新增 8 个 Loader 行),`tool-str-replace-editor` 行消失。**上游侧栏文件树走 `ctx.fs`** —— 因此远程 fs provider 让它自动显示远程目录树,自研的 `dsh-remote-ui` 抽屉(走面板 HTTP API)随之退役 | 旧版 `--dump-config` 对比新增/消失行;测试分区实跑 canary:bash 返回远程 Linux 内核、glob/grep 与远程真值一致;**上游重写的 `LocalSubprocessRuntime.spawn`(新增 cgroup scope / Windows job 进程约束)未打断我们的 `spawn` 覆盖**;我们禁用的 5 个行 id 全部仍在(patch 不会静默失效);升级后 web 实例的客户端插件图确认 `ui-sidebar-files`/`ui-sidebar-right`/`workspace-files` 与自研 `directory-picker-browse` 同挂 |

## 走不通的(留档以免重踩)

| 日期 | 尝试 | 结果 |
|---|---|---|
| 2026-09-03 | macOS 26 + Apple Silicon 上把远程目录做成真·系统挂载 | 三条路均受阻:WebDAV 挂载注册成功但访问 EPERM;SMB(guest/用户认证、回环/局域网 IP、标准/非标准端口)连接到不了服务端;FUSE-T + sshfs 报 `fuse: mount failed error: -1`。上游 issue 佐证:macOS 26 上 FSKit 扩展启用失败(#104)、26.6.2 上 SMB 连接不稳定(#113)、经 fuse-t 挂载触发 Apple NFS 内核 bug(#109)。结论:看远程文件用 VS Code Remote-SSH,不做系统挂载 |
| 2026-09-03 | 在本机与仓库之间做软链(单一数据源) | 放弃:本机是持续使用的生产环境,不应依赖仓库目录存在与否;改为解耦 + 同步脚本 |
| 2026-09-10 | 禁用 `dsh-host-directory-picker-auto` 后只补自己的宿主后端 | 「Add workspace」按钮消失。该包不是普通 provider,而是**成对挂载**适配器:启动时把宿主后端与客户端界面作为两个 Loader 条目一起挂(`BACKEND_PACKAGES` + `SURFACE_PACKAGES`),禁用它等于两面一起删。正解按官方注释「直接组合成对」:自己的后端 + `@deepseek-ai/dsh-client-ui-directory-picker-browse` |
| 2026-09-10 | ssh 连接复用的 ControlPath 放在 `$DSH_HOME/dsh-remote/.ssh-cm/` | Unix domain socket 的 `sun_path` 上限 104 字节,分区 home 路径长必然溢出(`ControlPath too long`);且 ssh 还会在该路径后追加 `.` + 16 位随机后缀,长度守卫必须按**展开后**计算。改用 `/tmp/dsh-ssh-cm/%C`;复用生效后单次 ssh 从 0.58s 降到 0.08s |
| 2026-09-10 | 用 `curl` 直接抓 dsh web 实例页面做程序化验证 | token 是一次性的,且 `dsh web` 默认会自动打开浏览器把 token 消费掉;必须先 `--no-open` 起实例,再用 `?token=` 换 cookie(303 + `Set-Cookie`)带 cookie jar 跟进去才能拿到页面 |
| 2026-09-11 | 在测试分区里用新引擎版本实测 | 踩雷:`$DSH_HOME/profiles/node_modules` 若是**指向另一个 home 的符号链接**,启动时会按「治愈到当前运行的安装」的逻辑**穿透改写对方** —— 等于拿新版本跑一次测试就污染了生产环境的模块解析。测试分区必须先把它换成独立目录(启动时自建) |
| 2026-09-11 | 排查三个实例同时不可达 | 白查一场:服务是**用户自己在面板上「全部断开」关的**。事后看判据一直摆在眼前 —— 三个同时消失而 supervisor/panel 都活着、启动日志只有启动行没有堆栈(SIGTERM 而非崩溃)、`tunnels.json` 变成空表(正是 disconnect-all 的正常输出)。**看到空表应先问「谁主动关的」,再往故障方向查** |
