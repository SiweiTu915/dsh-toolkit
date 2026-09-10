# dsh-plugin-amend

修改历史对话的插件骨架：把某条历史消息**替换**成新文本。

- 机制：compaction 同款的 **surface-replace**（追加已知类型事件 + `surfaceOp: {op:'replace'}`）
- 原则：会话日志保持 **append-only**，不改写历史字节；替换是"追加 + 表面层遮蔽"
- 状态：**Phase 1 骨架**（服务 + 命令 + 核心逻辑已实现并测试）；UI 显示层与自定义事件见下文 Roadmap

## 安装

在 `~/.dsh` 下执行（把插件装进 web profile，下次启动 GUI 生效）：

```sh
cd ~/.dsh
dsh plugin --profile web add ./plugins/dsh-plugin-amend
```

验证它进入了 profile 的 bundle 层：

```sh
dsh --profile web --dump-config | grep -A2 "history-amend"
```

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-amend
```

> 版本同步：harness 升级后建议 `dsh plugin --profile web update`，让插件的
> `@deepseek-ai/dsh-session` 等依赖副本跟上 harness 的版本。

## 使用

在 Web 界面输入斜杠命令（seq 是会话日志里目标消息事件的序号）：

```
/edit-message 12 修正后的回复内容
```

命令处理器会：

1. 用 `invocation.agent.session` 拿到当前 live 会话
2. 校验 seq 存在、是可替换的消息（`assistant/message` 或 `user/message`）、有文本内容、且仍在表面层上
3. 复用原消息的 `role`/`source`（provider/model），分配新 `id` 和文本，追加一条
   `assistant/message`（或 `user/message`）事件，携带
   `surfaceOp: { op: 'replace', start, end }` 与 `sourceEventSeqs: [目标seq]`
4. `ctx.sessions.flush(session)` 落盘，广播 `history/amended` 事件

## 程序化 API

```js
// 任何拿到 live Session 的地方（比如别的插件、命令、agent 作用域内）
await ctx.historyAmend.amend(session, targetSeq, '新文本')

// 或纯函数（可脱离 cordis 测试）
import { applyAmend } from 'dsh-plugin-amend'
const event = applyAmend(session, targetSeq, '新文本')
```

## 为什么这样设计（架构依据）

| 事实 | 来源 |
|---|---|
| 日志唯一写接口是 `append`，读取从不重写旧记录 | `dsh-session-persistence` README |
| `Session.append(type, data, {surfaceOp, sourceEventSeqs})` 是官方追加路径 | `dsh-compaction-basic` 源码（`session.append("user/message", …, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs})`） |
| `session.surface.nodes` 公开给出模型可见表面层的节点 seq 列表 | `dsh-session` `SessionSurface` 类型 |
| 表面层替换语义：`{op:'replace', start, end}`，`start===end` 替换单节点，`sourceEventSeqs` 必须覆盖被遮蔽节点 | `dsh-session` `SurfaceOp` 类型 |
| 事件词表可合并扩展，但仓库外插件类型的**运行时注册面被推迟** | `known-event-types.d.ts` 注释 |

## 已知限制（诚实清单）

1. **UI 人类记录视图不显示替换副本**：框架语义是"append-origin 事件才是人类记录，
   替换副本 model-only"（`isAppendSurfaceEvent` 注释）——所以当前 Phase 1 的替换
   **改变模型看到的表面层**，但聊天界面默认仍显示原始文本。要让界面反映修改，
   需要 Phase 2 客户端 Definition（见下）。
2. 只支持替换 `assistant/message` 与 `user/message`；`hide`/`restore`（删除/恢复）未实现
   ——表面层没有"空洞"概念，删除需要别的手段（客户端过滤或未来自定义事件）。
3. 目标消息必须仍在表面层上（已被替换过的节点不能再替换）。
4. 命令输入里的 seq 需要用户自己知道；后续可在 UI 加"编辑"按钮（Phase 2）。

## Roadmap

- **Phase 2 — UI 显示层**：在 web profile 挂一个客户端插件，为 `assistant/message`
  的 replacement 副本注册 `ConversationNodeAssembler` Definition（类似 compaction
  checkpoint 的处理），把替换后的文本折叠进聊天视图，并在节点上标记"已编辑"。
  接入点：`dsh-client-runtime` 的 `ConversationNodeAssembler`（"Plugins register business
  Definitions that map one event to a stable {kind, id}…"）。
- **Phase 3 — 干净的自定义事件**：等框架开放 `Session.append` 的自定义事件注册面
  （含 `ignorable` 写入），切到 `history/amend` 事件（类型声明已在 `lib/index.d.ts` 备好）。

## 给上游（deepseek-harness）的需求建议

当前构建在 `known-event-types.d.ts` 注明 "a registration surface for them is deferred
until such a consumer exists"——现在消费者（本插件）存在了。最小改动建议：

1. `Session.append` 支持为一个插件注册的事件类型写入 `ignorable: true`（或提供
   运行时类型注册 API，注册后无需 ignorable）；
2. `KNOWN_SESSION_EVENT_TYPES` 允许运行时扩展（而不是构建时生成死目录）。

有了这两点，"追加自定义修正事件 + 表面层/UI 按事件应用"的最干净路径就能落地，
不再需要借道 `assistant/message` 的 replace。
