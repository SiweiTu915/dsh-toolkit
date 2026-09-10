/**
 * dsh-plugin-amend — 修改历史对话（替换某条消息的文本）
 *
 * 机制：compaction 同款的 surface-replace —— 追加一条「已知类型」的
 * assistant/user message 事件，带 `surfaceOp: { op: 'replace', start, end }`，
 * 把目标节点从模型可见表面层上替换掉。会话日志仍 append-only，不改写历史字节。
 *
 * 为什么不用自定义事件类型（如 history/amend）？
 *   dsh-session 的 SessionEventMap 是可合并扩展的，但运行时的
 *   KNOWN_SESSION_EVENT_TYPES 目录由构建生成，当前构建明确注明
 *   「out-of-repo plugin events … registration surface deferred」；
 *   而且 Session.append 构造事件时无法写入 ignorable 标记 —— 追加虽能成功，
 *   下次加载会话会被读取路径以「未知必需事件」拒绝。因此骨架走
 *   surfaceOp replace（compaction 声明「any surface-replacing producer may use it」），
 *   这是当前构建里唯一完全合规、可持久、可回放的历史替换路径。
 *
 * 已知限制（见 README）：
 *   - 只替换「模型可见表面层」；UI 人类记录视图不显示 replacement 副本
 *     （框架语义：append-origin 事件才是人类记录，替换副本 model-only），
 *     需要 Phase 2 的客户端 Definition 才能反映到聊天界面。
 *   - 只支持 assistant/message 与 user/message 目标；hide/restore 暂不支持。
 */
import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'

/** 预留：自定义修正事件（等框架开放运行时注册面后启用，见 README「给上游」一节）。 */
export const HISTORY_AMEND_EVENT = 'history/amend'

/** 目标消息事件里取「可替换的文本」，无文本内容则抛错。 */
function assertTextual(message) {
  const blocks = (message?.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string')
  if (!blocks.length) throw new Error('该消息没有可替换的文本内容')
  return blocks.map((b) => b.text).join('\n')
}

/** 构造带新文本的替换消息：复用原消息的 role/source，分配新 id。 */
function buildReplacement(message, text) {
  return {
    id: randomUUID(),
    role: message.role,
    content: [{ type: 'text', text }],
    source: message.source,
  }
}

/**
 * 核心替换操作（纯函数，可脱离 cordis 测试）：把 session 日志中
 * seq 为 targetSeq 的消息替换成 text。
 *
 * @param session 目标会话（live Session 或 detached Session）
 * @param targetSeq 目标消息事件 seq（session.events 下标）
 * @param text 新文本
 * @returns 追加的替换事件
 */
export function applyAmend(session, targetSeq, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('新文本不能为空')

  const target = session.events[targetSeq]
  if (!target) throw new Error(`seq ${targetSeq} 不存在（当前日志共 ${session.events.length} 条）`)
  if (target.type !== 'assistant/message' && target.type !== 'user/message') {
    throw new Error(`seq ${targetSeq} 是 ${target.type}，只能替换 assistant/message 或 user/message`)
  }

  const original = target.type === 'assistant/message' ? target.data.message : target.data
  assertTextual(original)

  const nodes = session.surface.nodes
  const index = nodes.indexOf(targetSeq)
  if (index < 0) {
    throw new Error(`seq ${targetSeq} 不在当前表面层上（可能已被替换或遮蔽），无法再次替换`)
  }

  const replacement = buildReplacement(original, text)

  // assistant/message 在事件数据层携带 turn/step：复用原值，保持折叠定位一致
  if (target.type === 'assistant/message') {
    return session.append(
      'assistant/message',
      { turn: target.data.turn, step: target.data.step, message: replacement },
      { surfaceOp: { op: 'replace', start: index, end: index }, sourceEventSeqs: [targetSeq] },
    )
  }
  return session.append(
    'user/message',
    replacement,
    { surfaceOp: { op: 'replace', start: index, end: index }, sourceEventSeqs: [targetSeq] },
  )
}

/** ctx.historyAmend 服务：包一层持久化 flush 与广播事件。 */
class HistoryAmendService extends Service {
  static inject = ['sessions']

  constructor(ctx) {
    super(ctx, 'historyAmend')
  }

  /**
   * 把 session 中 seq 为 targetSeq 的消息替换成 text，并落盘。
   * @param session live Session（例如命令调用里的 invocation.agent.session）
   * @param targetSeq 目标消息事件 seq
   * @param text 新文本
   * @returns 追加的替换事件
   */
  async amend(session, targetSeq, text) {
    const event = applyAmend(session, targetSeq, text)
    await this.ctx.sessions.flush(session)
    this.ctx.emit('history/amended', session, event)
    return event
  }
}

/** 插件入口：注册服务 + /edit-message 命令。 */
export function apply(ctx) {
  ctx.plugin(HistoryAmendService)

  ctx.commands.register({
    name: 'edit-message',
    description: '修改历史对话：把某条消息替换成新文本',
    input: { hint: '<消息seq> <新文本> — 例如 /edit-message 12 修正后的回复' },
    handler: async ({ agent, rawInput }) => {
      const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(rawInput)
      if (!match) {
        return { kind: 'error', text: '用法: /edit-message <消息seq> <新文本>' }
      }
      const targetSeq = Number(match[1])
      const text = match[2].trim()
      try {
        const event = await ctx.historyAmend.amend(agent.session, targetSeq, text)
        const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
        return {
          kind: 'success',
          text: `已把 seq ${targetSeq} 的消息替换为:「${preview}」（追加事件 seq ${event.seq}）`,
          sourceEventSeq: event.seq,
        }
      } catch (error) {
        return { kind: 'error', text: `替换失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}

export const name = 'dsh-plugin-amend'

export default { name, apply, inject: ['sessions', 'commands'] }
