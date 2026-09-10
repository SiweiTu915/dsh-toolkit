---
name: gpu-partition
description: 远程 GPU 工作分区模板——让本机 agent 通过 ssh/rsync 使用远程算力服务器(读写文件、跑训练、取结果)
whenToUse: 用户提到 GPU 分区 / 远程实验 / "在服务器上跑" / 需要远程算力跑训练时(需先按下方"接入步骤"填好你的服务器)
user-invocable: true
---

# 远程 GPU 工作分区(模板)

本机 dsh 是主工作台;**远程 GPU 服务器是一个"文件分区"**,不是另一套 dsh。所有操作通过 SSH 别名(下文用 `gpu` 代指)完成。

> **使用前先做**:把你的服务器填进来(见文末"接入步骤"),然后按你的实际值替换本文中的 `gpu`、`<数据盘路径>`、`<项目名>`。

## 看远程文件的正解(重要)

**浏览/编辑远程文件一律引导用户用 VS Code Remote-SSH**(连你的 SSH 别名即可,左侧文件树点开项目)——**不要**用 `ssh cat`/`ls` 给用户硬看一屏文件。分工:**VS Code 看文件,dsh/agent 干思考与执行**(设计、写代码逻辑、分析、跑实验)。

## 服务器事实(按你的环境替换)

- SSH:`ssh gpu`(免密,配在 `~/.ssh/config`)
- **数据盘:`<数据盘路径>`**——实验代码/数据放这里(系统盘通常很小)
- Python/conda:非交互 shell 里 conda 常不在 PATH,要用就
  `source <conda 路径>/etc/profile.d/conda.sh && conda activate <env>`
- ⚠️ **GPU 状态现场确认**:`ssh gpu nvidia-smi`。若是空输出/0 字节占位,说明实例处于**无卡模式**,训练前需到云控制台切 GPU 计费并重启

## 读写远程文件

```sh
# 读
ssh gpu 'cat <数据盘路径>/<项目>/README.md'
rsync -av gpu:<数据盘路径>/<项目>/ ./mirror/          # 整目录拉到本机

# 写
rsync -av ./experiments/ gpu:<数据盘路径>/<项目>/experiments/
```

## 在远程跑实验

```sh
ssh gpu 'cd <数据盘路径>/<项目> && source <conda 路径>/etc/profile.d/conda.sh && conda activate <env> \
  && nohup python train.py > train.log 2>&1 & echo $!'
ssh gpu 'tail -50 <数据盘路径>/<项目>/train.log'        # 看进度
```

**长任务必须守护**(SSH 断开会杀进程):`nohup ... &` + 日志,或 `tmux`/`screen`。

## 工作流(配合本机科研流程)

1. 本机 agent 读论文/写代码/分析 → 产出实验代码
2. `rsync` 推代码到远程项目目录
3. `ssh` 远程启动训练(先确认 GPU 模式 + conda 环境)
4. 轮询日志;结束后 `rsync` 拉回结果 → 用 `result-analysis` / `paper-writing` 技能继续

## 铁律

- **大文件别在分区与本机之间来回拷**——数据留在远程,能远程算的就在远程算
- 改服务器上的项目代码前先备份(远程目录通常不是 git)
- 装依赖先问清用哪个 conda env,别动 base 之外的
- 训练脚本一律守护进程 + 日志,不阻塞交互

## 接入步骤(一次性)

1. 云控制台把本机公钥配好(多数 GPU 云支持"设置密钥登录");本机公钥:`cat ~/.ssh/id_ed25519.pub`
2. 写 `~/.ssh/config`(把别名和端口换成你控制台给的):
   ```
   Host gpu
     HostName <控制台的 SSH 主机>
     Port <控制台的 SSH 端口>
     User root
     IdentityFile ~/.ssh/id_ed25519
     ServerAliveInterval 30
   ```
3. 验证:`ssh gpu 'echo ok; hostname'` + `rsync -av --dry-run gpu:<数据盘路径>/ /tmp/`
4. 把上面的 `gpu` / `<数据盘路径>` / `<项目名>` / conda 路径替换成本文的值
