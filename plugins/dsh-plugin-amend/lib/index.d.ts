import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 预留：自定义修正事件。当前构建的运行时事件目录（KNOWN_SESSION_EVENT_TYPES）
 * 不包含仓库外插件类型，且 Session.append 尚无法写入 ignorable 标记，
 * 待框架开放注册面后启用（见 README「给上游」）。
 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'history/amend': {
      /** 目标消息事件 seq */
      target: number
      action: 'replace' | 'hide' | 'restore'
      text?: string
      note?: string
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    historyAmend: HistoryAmendService
  }
  interface Events {
    'history/amended'(session: Session, event: SessionEvent): void
  }
}

export class HistoryAmendService extends Service {
  static inject: ['sessions']
  constructor(ctx: Context)
  amend(session: Session, targetSeq: number, text: string): Promise<SessionEvent>
}

/** 核心替换操作（纯函数）。 */
export function applyAmend(session: Session, targetSeq: number, text: string): SessionEvent

export function apply(ctx: Context): void
export const name: 'dsh-plugin-amend'
export const HISTORY_AMEND_EVENT: 'history/amend'
declare const plugin: { name: 'dsh-plugin-amend'; apply: typeof apply; inject: ['sessions', 'commands'] }
export default plugin
