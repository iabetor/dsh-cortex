/**
 * dsh-cortex — 提问提醒（presence-aware，TUI 版）。
 *
 * TUI 没有浏览器的 `visibilitychange`/`hasFocus`，无法直接判断用户是否离开。
 * 这里用**超时**近似：提问后等待 QUESTION_ALERT_DELAY_MS，仍未回答才提醒。
 * 用户就在终端前时通常几秒内作答，因此不会被打扰；离开了才会收到通知。
 *
 * 提醒手段：macOS 系统通知（`osascript -e 'display notification ...'`，
 * 系统自带、零依赖）。失败静默——提醒是尽力而为，绝不影响问答本身。
 *
 * @module dsh-cortex/notify
 */

import { execFile } from 'node:child_process'

/** 提问后多久未回答才提醒（毫秒）。 */
export const QUESTION_ALERT_DELAY_MS = 60_000

/** 通知标题（macOS 横幅显示）。 */
const NOTIFY_TITLE = 'dsh-cortex'

/** 摘要里问题正文的截断长度。 */
const SUMMARY_LIMIT = 80

/**
 * 转义 AppleScript 字符串字面量里的反斜杠与双引号。
 * @param value - 原始文本。
 * @returns 可安全嵌入 `"..."` 的形式。
 */
export function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 从问题列表生成通知正文（首问摘要 + 共几个）。 */
export function alertBody(questions: readonly { question?: string }[]): string {
  const first = questions[0]?.question?.trim() ?? ''
  const head = first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT)}…` : first
  const more = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
  return head === '' ? `${questions.length} 个问题待回答` : `${head}${more}`
}

/** 发一条 macOS 系统通知；失败静默（非 macOS / osascript 缺失都不报错）。 */
export function notifyMac(title: string, body: string): void {
  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
  try {
    execFile('osascript', ['-e', script], () => {
      // 回调必须存在：否则子进程错误会冒泡成未捕获异常。
    })
  } catch {
    // 提醒是尽力而为。
  }
}

/**
 * 提问提醒计时器：提问时启动，回答时取消。
 *
 * 一次只跟踪一个待答请求（cortex 是单 agent 单会话，agent 在提问处阻塞，
 * 不可能并发第二个提问）。
 */
export class QuestionAlertTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * 启动计时器；重复调用会先取消上一个。
   * @param questions - 待回答的问题（用于通知正文）。
   * @param onFire - 超时回调（默认发 macOS 通知）；测试可注入。
   */
  start(
    questions: readonly { question?: string }[],
    onFire: (title: string, body: string) => void = notifyMac,
  ): void {
    this.cancel()
    const timer = setTimeout(() => {
      this.timer = null
      onFire(NOTIFY_TITLE, alertBody(questions))
    }, QUESTION_ALERT_DELAY_MS)
    // 计时器不应阻止进程退出。
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref()
    }
    this.timer = timer
  }

  /** 取消待触发的提醒（用户已回答或提问被替换）。 */
  cancel(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /** 是否有待触发的提醒（测试用）。 */
  get pending(): boolean {
    return this.timer !== null
  }
}
