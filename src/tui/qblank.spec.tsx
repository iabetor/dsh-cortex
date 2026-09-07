import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionOverlay } from './question-overlay.tsx'
import type { QuestionItem } from '../driver.ts'

const Q: QuestionItem[] = [{
  id: 'q1',
  question: 'Which databases do you prefer? (long question that may wrap at narrow widths)',
  multiSelect: true,
  options: [
    { label: 'PostgreSQL', description: 'ACID relational DB with rich extensions (JSONB, full-text, extensions) and strong managed hosting' },
    { label: 'MySQL', description: 'Popular relational DB with extensive managed hosting options worldwide' },
    { label: 'MongoDB', description: 'Document-oriented NoSQL store, flexible schema for rapid iteration' },
    { label: '其他' },
  ],
}]

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('blank line accumulation on arrow keys', () => {
  it('frame height stays stable across up/down presses', async () => {
    const app = render(<QuestionOverlay questions={Q} onAnswer={() => {}} />)
    await wait(120)
    const heights: number[] = []
    const countLines = (f: string | undefined): number => (f ?? '').split('\n').filter(l => l.trim() !== '').length
    heights.push(countLines(app.lastFrame()))
    // 20 down/up cycles.
    for (let i = 0; i < 10; i++) {
      app.stdin.write('\u001b[B')
      await wait(40)
      app.stdin.write('\u001b[A')
      await wait(40)
      heights.push(countLines(app.lastFrame()))
    }
    console.log('LINE COUNTS:', JSON.stringify(heights))
    // All frames should have roughly the same non-blank line count
    // (no growth = no blank accumulation).
    const min = Math.min(...heights)
    const max = Math.max(...heights)
    expect(max - min).toBeLessThanOrEqual(2)
    app.unmount()
  })
})
