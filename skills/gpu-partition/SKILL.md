---
name: gpu-partition
description: 远程 GPU 工作分区模板——让本机 dsh 把远程算力服务器当成一个"文件与执行分区":读/写/搜索/跑命令直接落在远程,本机零拷贝
whenToUse: 用户提到 GPU 分区 / 远程实验 / "在服务器上跑" / 需要远程算力跑训练时(需先按"接入步骤"填好你的服务器)
user-invocable: true
---

# 远程 GPU 工作分区(模板)

本机 dsh 是主工作台;**远程 GPU 服务器是一个"分区"**,不是另一套 dsh。SSH 别名下文用 `gpu` 代指。

> **使用前先做**:按文末「接入步骤」填好你的服务器,再把本文里的 `gpu`、`<数据盘路径>`、`<项目名>`、`<本机 home>` 替换成实际值。

两种用法,任选:

| 用法 | 交互 | 适合 |
|---|---|---|
| **挂载型工作台**(推荐) | 分区里 `read`/`write`/`edit`/`bash`/`glob`/`grep` 全部直接在远程执行 | 日常在远程机上写代码、跑实验 |
| **rw.mjs** | 本机一条命令做一次远程文件操作 | 没建分区、或只想临时看一眼 |

## 一、挂载型工作台:执行世界整体搬到远程

原理:dsh 的**三个执行接缝**都是可替换的契约(`ctx.fs` / `ctx.subprocess` / `ctx.shell`),各写一个远程 provider 就能让整个分区跑在远程机上。本机那侧只留一个 **0 字节的空挂载点目录**,不产生任何文件副本。

| 接缝 | 覆盖的工具 | provider |
|---|---|---|
| fs | `read` / `write` / `edit` | `dsh-fs-sftp` |
| subprocess | `glob` / `grep` | `dsh-subprocess-sftp` |
| shell | `bash` | `dsh-bash-sftp` |
| (目录选择器) | 「Add workspace」 | `dsh-directory-picker-sftp` |

路径映射靠一个配置文件(`<分区 DSH_HOME>/remote-mount.json`,四个 provider 共用):

```json
{
  "remoteDir": "<本机 home>/.dsh/dsh-remote",
  "server": "gpu",
  "remoteRoot": "/root",
  "localRoot": "<本机 home>/.dsh/remote-workspaces/gpu"
}
```

即 `<localRoot>/<数据盘相对路径>` ⇄ `/root/<数据盘相对路径>`。本机只有空目录骨架,内容全在远程。

### 建分区

面板(`dsh-remote/panel.mjs`)顶部有「新建远程工作台」:选机器 + 填远程根目录 → 自动建 home/profile、装 4 个 provider、写映射、建挂载点、继承凭证与技能、注册并启动。等价的手工步骤:

```sh
DSH_HOME=<新分区 home> dsh plugin --profile web add \
  link:<本机 home>/.dsh/plugins/dsh-fs-sftp \
  link:<本机 home>/.dsh/plugins/dsh-subprocess-sftp \
  link:<本机 home>/.dsh/plugins/dsh-bash-sftp \
  link:<本机 home>/.dsh/plugins/dsh-directory-picker-sftp
# 再把这四个包名加进该 profile package.json 的 dsh.profile.bundles,并写 remote-mount.json
```

### 「Add workspace」直接挑远程目录

目录选择器也是接缝(`ctx.directoryPicker`)。换成远程版后,对话框里浏览的是**远程机上的真实目录树**,面包屑显示 `<server>:<remoteRoot> › <数据盘> › <项目>`;选中即可用 —— 因为列举时会把每个目录在本机物化成空占位,满足工作区注册表要求的本机校验。新建文件夹会同时在远程与本机建。

⚠️ **必须成对挂载**。默认行 `@deepseek-ai/dsh-host-directory-picker-auto` 是"成对挂载"适配器:它在启动时把**宿主后端**与**客户端界面**作为两个 Loader 条目一起挂(`BACKEND_PACKAGES` + `SURFACE_PACKAGES`)。只禁用它、只插自己的宿主后端,客户端界面不会加载 —— 表现是**按钮直接消失**。正解(官方注释:「直接组合成对」):

```yaml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-sftp
      name: 'dsh-directory-picker-sftp'
    - id: directory-picker-browse-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

### 两个必须知道的限制

1. **挂载点之外的 workdir 会被拒绝**(`outsideMount: "refuse"`)。要在分区里干活,先把工作区设到挂载点或其子目录,否则命令会报"不在远程挂载点之内"。
2. **终止只杀本机 ssh 客户端,远端进程组不会被杀** —— 这是 ssh 的固有行为,所以工具超时**收不掉**远程进程。**长任务仍然必须** `nohup ... &` 或 `tmux`。

另外:SFTP 的 `stat` 没有 inode/ctime,stale-write 保护只能靠 `mode:size:mtime`,粒度比本地粗。

## 二、rw.mjs(轻量方式)

不建分区、只做单次远程文件操作时用:

```sh
node <本机 home>/.dsh/dsh-remote/rw.mjs <命令> gpu [参数]
```

| 需求 | 命令 |
|---|---|
| 看目录 / 结构 | `ls gpu <路径>` / `tree gpu <路径> --depth 2` |
| 看元信息 | `stat gpu <路径>` |
| 读文件 | `read gpu <路径>`(大文件加 `--head 50` / `--tail 50`) |
| 搜索内容 / 找文件 | `grep gpu <目录> --pattern "正则"` / `find gpu <目录> --name "*.py"` |
| 创建 / 覆盖 | `write gpu <路径> --text "内容"`(或 `--from 本机文件`、`--stdin`) |
| 定向修改 | `edit gpu <路径> --old "原文" --new "新文" [--all]`(不匹配会报错且不改) |
| 建目录 / 复制 / 移动 / 删除 | `mkdir` / `cp` / `mv` / `rm [-r]` |
| 远程执行 | `exec gpu "命令"` |

改之前先 `read` 确认上下文;写操作可先加 `--dry-run` 预览。

## 三、看文件

**挂载型工作台自带右侧栏文件树**(dsh 0.1.5 起):展开即可看远程目录树与文档预览。它走 `ctx.fs` 接缝,所以在挂载型分区里显示的就是**远程**的文件树,不需要额外插件。

人工要**大范围浏览/编辑**时仍建议 **VS Code Remote-SSH**(连你的 SSH 别名,左侧文件树点开项目);不要用 `ssh cat`/`ls` 给用户刷屏。分工:**VS Code 看文件,dsh/agent 干思考与执行**。

## 服务器事实(按你的环境替换)

- SSH:`ssh gpu`(免密,配在 `~/.ssh/config`)
- **数据盘:`<数据盘路径>`** —— 实验代码/数据放这里(系统盘通常很小)
- conda 在非交互 shell 里常不在 PATH:`source <conda 路径>/etc/profile.d/conda.sh && conda activate <env>`
- ⚠️ **上机先确认 GPU 模式**:`ssh gpu nvidia-smi`。空输出/0 字节占位说明实例处于**无卡模式**,训练前需到云控制台切 GPU 计费并重启

## 在远程跑实验

挂载型分区里直接用 `bash` 工具(workdir 用挂载点内的相对路径):

```sh
cd <数据盘相对路径>/<项目> && source <conda 路径>/etc/profile.d/conda.sh && conda activate <env> \
  && nohup python train.py > train.log 2>&1 & echo started
tail -30 train.log                      # 看进度
```

非分区环境用 rw.mjs 等价地做:

```sh
node <本机 home>/.dsh/dsh-remote/rw.mjs exec gpu \
  "cd <数据盘路径>/<项目> && source <conda 路径>/etc/profile.d/conda.sh && conda activate <env> && nohup python train.py > train.log 2>&1 & echo started"
node <本机 home>/.dsh/dsh-remote/rw.mjs read gpu <数据盘路径>/<项目>/train.log --tail 30
```

**长任务必须守护**(SSH 断开会杀前台进程):`nohup ... &` + 日志,或 `tmux`/`screen`。

## 工作流

1. 本机 agent 读论文/写代码/分析 → 产出实验代码
2. 代码直接写进挂载点(或 rw.mjs 推送)到远程项目目录
3. 远程启动训练(先确认 GPU 模式 + conda 环境)
4. 轮询日志;结束后读回结果 → 用 `result-analysis` / `paper-writing` 继续

## 铁律

- **不把远程文件拉到本机**:就地读写(挂载型用原生工具,否则用 rw.mjs);只有用户明确要某个结果文件时才输出内容
- **大数据(数据集/模型/压缩包)只看不读**:`ls`/`stat`/`tree` 看结构即可,别去读几十 G 的目录
- 改远程项目代码前先确认上下文;远程目录通常不是 git,批量改动先 `--dry-run`
- 装依赖先问清用哪个 conda env,别动 base 之外的

## 接入步骤(一次性)

1. 云控制台配好本机公钥(多数 GPU 云支持"设置密钥登录");本机公钥:`cat ~/.ssh/id_ed25519.pub`
2. 写 `~/.ssh/config`(别名与端口换成控制台给的):
   ```
   Host gpu
     HostName <控制台的 SSH 主机>
     Port <控制台的 SSH 端口>
     User root
     IdentityFile ~/.ssh/id_ed25519
     ServerAliveInterval 30
   ```
3. 验证:`ssh gpu 'echo ok; hostname'`
4. 把 `gpu` 加进 `dsh-remote/servers.json`(含 `conn: { host, user, sshPort }`),然后按本文替换 `gpu` / `<数据盘路径>` / `<项目名>` / `<本机 home>` / conda 路径
