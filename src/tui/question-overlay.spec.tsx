/**
 * QuestionOverlay tests: verify per-question state isolation (no cross-
 * question answer bleed) and multi-select behavior.
 *
 * Bug regression: answers from question A leaked into question B because the
 * OptionPicker component instance was reused across questions (no key), so
 * its `checked` state survived the question switch. Each question must
 * remount with clean selection state.
 *
 * @module dsh-cortex/tui/question-overlay.spec
 */

import { describe, expect, it } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionOverlay } from './question-overlay.tsx'
import type { QuestionItem, QuestionAnswer } from '../driver.ts'

/** Two questions with disjoint options — the classic bleed scenario. */
const QUESTIONS: QuestionItem[] = [
  {
    id: 'ms_a',
    question: 'Pick options A (multi)',
    multiSelect: true,
    options: [
      { label: '选项甲' },
      { label: '选项乙' },
      { label: '选项丙' },
    ],
  },
  {
    id: 'ms_b',
    question: 'Pick colors (multi)',
    multiSelect: true,
    options: [
      { label: '红色' },
      { label: '蓝色' },
      { label: '绿色' },
    ],
  },
]

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Send a keypress and let React settle. */
async function press(app: ReturnType<typeof render>, input: string): Promise<void> {
  app.stdin.write(input)
  await wait(60)
}

describe('QuestionOverlay per-question isolation', () => {
  it('submits each question with its OWN options only (no cross-bleed)', async () => {
    let received: QuestionAnswer | undefined
    const app = render(
      <QuestionOverlay
        questions={QUESTIONS}
        onAnswer={(a) => { received = a }}
      />,
    )

    // Question 1 (ms_a): cursor is on 选项甲. Space to check it.
    await press(app, ' ')
    // Move down one (to 选项乙), check it too.
    await press(app, '\u001b[B') // down arrow
    await press(app, ' ')
    // Enter submits question 1's checked set: [选项甲, 选项乙]
    await press(app, '\r')
    await wait(120)

    // Question 2 (ms_b): cursor is on 红色 (fresh mount). Space to check it.
    await press(app, ' ')
    // Move down to 蓝色 and check it.
    await press(app, '\u001b[B')
    await press(app, ' ')
    // Enter submits question 2: [红色, 蓝色]
    await press(app, '\r')
    await wait(120)

    expect(received).toBeDefined()
    expect(received?.answers).toHaveLength(2)

    const a = received?.answers.find(x => x.id === 'ms_a')
    const b = received?.answers.find(x => x.id === 'ms_b')
    expect(a?.selected).toEqual(['选项甲', '选项乙'])
    expect(b?.selected).toEqual(['红色', '蓝色'])

    // The critical assertion: no bleed across questions.
    expect(b?.selected.some(s => s.includes('选项'))).toBe(false)
    expect(a?.selected.some(s => s.includes('色'))).toBe(false)

    app.unmount()
  })
})
