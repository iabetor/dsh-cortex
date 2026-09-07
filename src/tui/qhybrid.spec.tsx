import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionOverlay } from './question-overlay.tsx'
import type { QuestionItem, QuestionAnswer } from '../driver.ts'

const HYBRID: QuestionItem[] = [{
  id: 'hybrid_1',
  question: 'Pick all that apply (multi, can add other)',
  multiSelect: true,
  options: [
    { label: '选项甲' },
    { label: '选项乙' },
    { label: '其他' },
  ],
}]

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function press(app: ReturnType<typeof render>, input: string): Promise<void> {
  app.stdin.write(input)
  await wait(70)
}

describe('hybrid option + custom text', () => {
  it('submits checked options AND custom text together (no hooks crash)', async () => {
    let received: QuestionAnswer | undefined
    let error: unknown
    const app = render(
      <QuestionOverlay questions={HYBRID} onAnswer={(a) => { received = a }} />,
    )
    try {
      await press(app, ' ')
      await press(app, '\u001b[B')
      await press(app, ' ')
      await press(app, '\u001b[B')
      await press(app, '\r')
      await wait(250)
      for (const ch of '补充说明') {
        await press(app, ch)
      }
      await press(app, '\r')
      await wait(150)
    } catch (e) {
      error = e
    }
    expect(error).toBeUndefined()
    expect(received).toBeDefined()
    const a = received?.answers.find(x => x.id === 'hybrid_1')
    expect(a?.selected).toEqual(['选项甲', '选项乙', '其他'])
    expect(a?.custom).toBe('补充说明')
    app.unmount()
  })
})
