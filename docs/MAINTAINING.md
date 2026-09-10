# 维护指南

这个仓库长期维护**对 DSH(DeepSeek Harness)的改造与升级**。新能力按这里的结构加,保证别人能看懂、能复用,也保证你的私人数据永不外泄。

## 目录约定

| 目录 | 放什么 | 判断标准 |
|---|---|---|
| `tools/` | 与框架版本无关的独立工具(单文件 Node 脚本,零依赖) | "任何 DSH 用户都可能需要" |
| `dsh-remote/` | 多服务器远程面板(脚本 + Web 面板 + 常驻服务) | 多机/远程管理相关 |
| `plugins/` | 示例或通用插件(每个插件一个目录,自带 README) | 需要挂进 profile 的能力 |
| `skills/` | **通用**技能模板(不含个人研究方法论) | 别人拿去改改就能用 |
| `docs/` | 文档(命令速查、架构说明) | — |

## 加一个新改造的流程

1. **在本机做出来并验证能用**(先在你自己的 `~/.dsh` 里跑通,包括边界情况和报错路径)
2. **判断归类**:按上表放进对应目录;一次改造涉及多处就分别放
3. **脱敏**(最重要,逐条过):
   - 删掉:服务器地址/端口、密码/token、个人绝对路径(`/Users/xxx`)、个人项目名、任何凭据
   - 用占位符替换:`<你的服务器>`、`<数据盘路径>`、`<项目名>`、`gpu`(SSH 别名)
   - 通用化:把"我的用法"改写成"模板 + 接入步骤"
4. **写/更新文档**:README 的组件表加一行;新目录自带 README 或 SKILL.md 说明用途、前置条件、已知限制
5. **自检**(提交前必跑):
   ```sh
   # 扫描敏感串(把关键词换成你真实用到的)
   grep -rn -E "你的服务器域名|你的密码片段|/Users/你的用户名" . | grep -v "^\./\.git/"
   node --check tools/*.mjs dsh-remote/*.mjs plugins/*/lib/*.js 2>/dev/null
   ```
6. **提交并推送**:
   ```sh
   git add -A && git commit -m "feat: <做了什么>" && git push
   ```

## 保持"本机使用"与"仓库版本"同步

两种方式,选一种并坚持:

**A. 单一数据源(推荐,避免漂移)**:让 `~/.dsh` 里的文件用**软链**指向仓库,改任意一处都是同一个文件。
```sh
ln -sfn ~/.dsh/publish/dsh-toolkit/tools/update-dsh.mjs   ~/.dsh/update-dsh.mjs
ln -sfn ~/.dsh/publish/dsh-toolkit/tools/migrate-dsh.mjs  ~/.dsh/migrate-dsh.mjs
ln -sfn ~/.dsh/publish/dsh-toolkit/dsh-remote             ~/.dsh/dsh-remote
ln -sfn ~/.dsh/publish/dsh-toolkit/plugins/dsh-plugin-amend ~/.dsh/plugins/dsh-plugin-amend
ln -sfn ~/.dsh/publish/dsh-toolkit/skills/gpu-partition    ~/.dsh/skills/gpu-partition
```
个人配置(如 `dsh-remote/servers.json`)会跟着落在仓库目录里,但已被 `.gitignore` 排除,**不会提交**。

**B. 手动同步(简单,但要记得)**:改完 `~/.dsh` 的原件后,拷贝到仓库再提交:
```sh
cp ~/.dsh/update-dsh.mjs  ~/.dsh/publish/dsh-toolkit/tools/
cp ~/.dsh/migrate-dsh.mjs ~/.dsh/publish/dsh-toolkit/tools/
# dsh-remote / plugins / skills 同理
cd ~/.dsh/publish/dsh-toolkit && git add -A && git commit -m "sync: ..." && git push
```

## 版本更新后要做什么

DSH 升级(rc/alpha 迭代)后,本仓库的资产可能要跟着调:

1. `node ~/.dsh/update-dsh.mjs update` 升级引擎(自带冒烟与回滚)
2. 手动验证受影响的资产:插件能否挂载(`dsh --profile web --dump-config | grep <插件 id>`)、远程面板能否连接、技能是否仍被发现
3. 若某资产因上游 API 变化而失效 → 修好 → 按上面流程提交,并在提交信息里写清"因 DSH x.y.z 的某变化而调整"

## 铁律

- **永不提交**:凭据、会话数据、个人配置、真实服务器地址 —— 公开仓库的历史删不干净
- **零依赖**:工具只用 Node 内置模块;能用系统自带能力(ssh/rsync)就不引入第三方
- **每个改造都要有"已知限制"**:写清它做不到什么,比吹它多强更有用
