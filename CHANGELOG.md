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

## 走不通的(留档以免重踩)

| 日期 | 尝试 | 结果 |
|---|---|---|
| 2026-09-03 | macOS 26 + Apple Silicon 上把远程目录做成真·系统挂载 | 三条路均受阻:WebDAV 挂载注册成功但访问 EPERM;SMB(guest/用户认证、回环/局域网 IP、标准/非标准端口)连接到不了服务端;FUSE-T + sshfs 报 `fuse: mount failed error: -1`。上游 issue 佐证:macOS 26 上 FSKit 扩展启用失败(#104)、26.6.2 上 SMB 连接不稳定(#113)、经 fuse-t 挂载触发 Apple NFS 内核 bug(#109)。结论:看远程文件用 VS Code Remote-SSH,不做系统挂载 |
| 2026-09-03 | 在本机与仓库之间做软链(单一数据源) | 放弃:本机是持续使用的生产环境,不应依赖仓库目录存在与否;改为解耦 + 同步脚本 |
