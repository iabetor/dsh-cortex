import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QUESTION_ALERT_DELAY_MS, QuestionAlertTimer, alertBody, escapeAppleScript,
} from './notify.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('escapeAppleScript', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeAppleScript('普通文本 with English')).toBe('普通文本 with English')
  })
})

describe('alertBody', () => {
  it('uses the first question as the body', () => {
    expect(alertBody([{ question: '继续吗？' }])).toBe('继续吗？')
  })

  it('appends the count when several questions are asked', () => {
    expect(alertBody([{ question: '第一个？' }, { question: '第二个？' }])).toBe('第一个？（共 2 个问题）')
  })

  it('truncates a long question', () => {
    const long = 'x'.repeat(200)
    const body = alertBody([{ question: long }])
    expect(body.length).toBeLessThan(100)
    expect(body.endsWith('…')).toBe(true)
  })

  it('falls back to a count when the question text is empty', () => {
    expect(alertBody([{ question: '   ' }])).toBe('1 个问题待回答')
  })
})

describe('QuestionAlertTimer', () => {
  it('fires the alert after the delay', async () => {
    vi.useFakeTimers()
    const timer = new QuestionAlertTimer()
    const fired = vi.fn()

    timer.start([{ question: '继续吗？' }], fired)
    expect(timer.pending).toBe(true)
    expect(fired).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(QUESTION_ALERT_DELAY_MS + 10)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(fired).toHaveBeenCalledWith('dsh-cortex', '继续吗？')
    expect(timer.pending).toBe(false)
  })

  it('does not fire when cancelled (the human answered in time)', async () => {
    vi.useFakeTimers()
    const timer = new QuestionAlertTimer()
    const fired = vi.fn()

    timer.start([{ question: '继续吗？' }], fired)
    timer.cancel()
    expect(timer.pending).toBe(false)

    await vi.advanceTimersByTimeAsync(QUESTION_ALERT_DELAY_MS + 10)
    expect(fired).not.toHaveBeenCalled()
  })

  it('replaces a previous timer instead of stacking alerts', async () => {
    vi.useFakeTimers()
    const timer = new QuestionAlertTimer()
    const first = vi.fn()
    const second = vi.fn()

    timer.start([{ question: '第一个' }], first)
    await vi.advanceTimersByTimeAsync(QUESTION_ALERT_DELAY_MS / 2)
    timer.start([{ question: '第二个' }], second)

    await vi.advanceTimersByTimeAsync(QUESTION_ALERT_DELAY_MS + 10)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('is a no-op to cancel when nothing is pending', () => {
    const timer = new QuestionAlertTimer()
    expect(() => { timer.cancel() }).not.toThrow()
    expect(timer.pending).toBe(false)
  })
})
