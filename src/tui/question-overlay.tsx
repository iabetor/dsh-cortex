/**
 * dsh-cortex question overlay — renders agent ask_user_question cards in the
 * terminal (codex-style interactive questions). Option questions use an
 * ↑/↓ picker (plus a "✏️ 自定义答案" free-text row); optionless questions
 * collect a typed answer. Answers go back to the parked store promise, which
 * resolves the agent's tool call.
 *
 * @module dsh-cortex/tui/question-overlay
 */

import React, { useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'
import { CortexTextInput } from './text-input.tsx'
import type { QuestionItem, QuestionAnswer } from '../driver.ts'

/** Props for the question overlay. */
export interface QuestionOverlayProps {
  questions: readonly QuestionItem[]
  /** Call with the final answers. */
  onAnswer: (answer: QuestionAnswer) => void
}

/** Display width of a string (CJK/emoji count double). */
function sw(s: string): number {
  return stringWidth(s)
}

/** Truncate a string so its DISPLAY width (not char count) fits `maxWidth`. */
function truncateWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (sw(s) <= maxWidth) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = sw(ch)
    if (w + cw > maxWidth) break
    out += ch
    w += cw
  }
  return out
}

/** Pre-wrap text into display lines at a fixed DISPLAY width. */
function splitText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (sw(raw) <= width) {
      lines.push(raw)
    } else {
      let rest = raw
      while (sw(rest) > width) {
        // Greedy char-by-char break at display width.
        let acc = ''
        let w = 0
        for (const ch of rest) {
          const cw = sw(ch)
          if (w + cw > width) break
          acc += ch
          w += cw
        }
        if (acc === '') break // defensive: single char wider than width
        lines.push(acc)
        rest = rest.slice(acc.length)
      }
      if (rest !== '') lines.push(rest)
    }
  }
  return lines
}

/**
 * Step through the agent's questions: options → ↑/↓ picker with a free-text
 * custom row; no options → free text input. Enter confirms, q skips.
 */
export function QuestionOverlay(props: QuestionOverlayProps): React.JSX.Element {
  const { questions, onAnswer } = props
  const { stdout } = useStdout()
  const width = Math.max(30, (stdout.columns ?? 80) - 4)
  const [index, setIndex] = useState(0)
  const question = questions[index]
  const answersRef = useRef<{ id: string; selected: string[]; custom?: string }[]>([])
  // Guard: never finish the same question twice (fast double-Enter).
  const finishedRef = useRef<string | null>(null)

  if (question === undefined) {
    return <Box><Text dimColor>— no questions —</Text></Box>
  }

  const finishCurrent = (selected: string[], custom: string | undefined): void => {
    if (finishedRef.current === question.id) return
    finishedRef.current = question.id
    answersRef.current.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) })
    if (index === questions.length - 1) onAnswer({ answers: answersRef.current })
    else setIndex(i => i + 1)
  }

  /** Skip the current question (q/Esc): empty answer, keep earlier answers. */
  const skipCurrent = (): void => {
    finishCurrent([], undefined)
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Box>
        <Text color="yellow" bold>{'❓ '}{question.header ?? '模型提问'}</Text>
        <Text dimColor>  ({index + 1}/{questions.length})</Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        {splitText(question.question, width).map((l, i) => <Text key={`q${i}`}>{l}</Text>)}
        {question.detail !== undefined && question.detail !== '' && (
          splitText(question.detail, width).map((l, i) => <Text key={`d${i}`} dimColor>{l}</Text>)
        )}
      </Box>
      {(question.options ?? []).length > 0
        ? (
          <OptionPicker
            key={question.id}
            options={question.options ?? []}
            width={width}
            multi={question.multiSelect === true}
            onDone={(selected, custom) => finishCurrent(selected, custom)}
            onCancel={skipCurrent}
          />
        )
        : (
          <FreeTextInput
            key={question.id}
            onDone={(custom) => finishCurrent([], custom)}
            onCancel={skipCurrent}
            cancelLabel="跳过此题"
          />
        )}
    </Box>
  )
}

/** ↑/↓ option picker for one question. Every row is forced to ONE physical
 *  terminal line (label + description truncated to the width) so ink never
 *  soft-wraps a row — soft wrap mis-measures row height and accumulates
 *  blank lines on each arrow-key redraw. A trailing "✏️ 自定义答案" row
 *  switches to free-text input. */
function OptionPicker(props: {
  options: readonly { label: string; description?: string }[]
  width: number
  /** When true, Space toggles selection and Enter submits all checked. */
  multi: boolean
  onDone: (selected: string[], custom: string | undefined) => void
  onCancel: () => void
}): React.JSX.Element {
  const { options, width, multi, onDone, onCancel } = props
  const [cursor, setCursor] = useState(0)
  const [checked, setChecked] = useState<string[]>([])
  // Ref mirror of checked — the custom-mode branch renders after setChecked
  // in the same input event, and the render-time closure can be stale.
  const checkedRef = useRef<string[]>([])
  // Multi-select empty-submit confirmation (avoid accidental empty answer).
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  // Free-text custom answer mode (the "✏️ 自定义" row was picked).
  const [customMode, setCustomMode] = useState(false)
  // "✏️ 自定义答案" is a virtual last row.
  const rowCount = options.length + 1

  const toggleChecked = (label: string): void => {
    setChecked(prev => {
      const next = prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]
      checkedRef.current = next
      return next
    })
    setConfirmEmpty(false)
  }
  const addChecked = (label: string): void => {
    setChecked(prev => {
      if (prev.includes(label)) return prev
      const next = [...prev, label]
      checkedRef.current = next
      return next
    })
  }

  // All hooks must run before any early return (React rules of hooks) —
  // customMode toggles this component between picker and text input views.
  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(c => (c - 1 + rowCount) % rowCount)
      return
    }
    if (key.downArrow) {
      setCursor(c => (c + 1) % rowCount)
      return
    }
    if (input === ' ') {
      // Multi-select: space toggles the cursor option.
      if (multi && cursor < options.length) {
        const label = options[cursor]?.label
        if (label === undefined) return
        toggleChecked(label)
      }
      return
    }
    if (key.return) {
      // Custom row (last): switch to free-text input.
      if (cursor === options.length) {
        setCustomMode(true)
        return
      }
      const label = options[cursor]?.label
      if (label === undefined) return
      let submitSelected: string[]
      if (multi) {
        if (checked.length === 0 && !confirmEmpty) {
          // First Enter with nothing checked: ask for confirmation.
          setConfirmEmpty(true)
          return
        }
        // Enter on an UNCHECKED option row selects it too (cursor intent).
        if (!checked.includes(label)) {
          addChecked(label)
          submitSelected = [...checked, label]
        } else {
          submitSelected = checked
        }
      } else {
        submitSelected = [label]
      }
      // If the selection includes an "other"-style option, ask for the free
      // text that goes with it (hybrid option + input question). Ensure the
      // other option itself is part of the checked set.
      if (submitSelected.some(s => /other|其他|自定义|not listed|其它/i.test(s))) {
        if (multi && cursor < options.length) addChecked(label)
        setCustomMode(true)
        return
      }
      onDone(submitSelected, undefined)
      return
    }
    if (key.escape || input === 'q') {
      onCancel()
    }
  })

  if (customMode) {
    // The options carried into the custom text: for single-select that is the
    // cursor option that triggered custom mode; for multi the checked set
    // (read from the ref mirror — the state may not have flushed yet).
    const customSelected = multi ? checkedRef.current : [options[cursor]?.label ?? ''].filter(s => s !== '')
    return (
      <FreeTextInput
        onDone={(custom) => onDone(customSelected, custom)}
        onCancel={() => setCustomMode(false)}
        placeholder={customSelected.length > 0
          ? '输入补充说明… (与已选项一起提交)'
          : '输入自定义答案… (Enter 提交)'}
        cancelLabel="返回选项"
      />
    )
  }

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const marker = i === cursor ? '❯ ' : '  '
        const isChecked = checked.includes(opt.label)
        const check = multi ? (isChecked ? '[✓] ' : '[ ] ') : ''
        const maxLabel = Math.max(5, Math.floor(width * 0.4) - sw(check))
        const label = truncateWidth(opt.label, maxLabel)
        // desc gets whatever width remains after the ACTUAL rendered label.
        const used = sw(marker) + sw(check) + sw(label)
        const descWidth = Math.max(0, width - used)
        const desc = opt.description === undefined
          ? ''
          : truncateWidth(`  ${opt.description}`, descWidth)
        return (
          <Box key={opt.label} width={width}>
            <Text color={i === cursor ? 'cyan' : undefined} bold={i === cursor}>{marker}{check}{label}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        )
      })}
      {/* Custom free-text entry (last virtual row). */}
      <Box width={width}>
        <Text color={cursor === options.length ? 'cyan' : undefined} bold={cursor === options.length}>
          {cursor === options.length ? '❯ ' : '  '}✏️ 自定义答案…
        </Text>
      </Box>
      <Text dimColor>
        {multi && confirmEmpty
          ? '  ⚠️ 未选择任何项 — 再按 Enter 提交空答案，或空格勾选'
          : multi
            ? '  ↑/↓ 移动 · 空格 勾选 · Enter 提交 · ✏️ 自定义 · q 跳过此题'
            : '  ↑/↓ 选择 · Enter 确认 · ✏️ 自定义 · q 跳过此题'}
      </Text>
    </Box>
  )
}

/** Free-text answer input.
 *
 * Two contexts share this component:
 *  - Optionless question (skip = finish empty): Esc skips this question.
 *  - Custom row inside an option question (cancel = back to options):
 *    Esc returns to the option list; `backLabel` shows the right hint.
 *
 * Empty Enter first asks for confirmation, a second Enter submits empty.
 */
function FreeTextInput(props: {
  onDone: (custom: string) => void
  /** Esc action: skip the question (optionless) or back to options (custom). */
  onCancel: () => void
  placeholder?: string
  /** Hint for what Esc does; default "跳过此题". */
  cancelLabel?: string
}): React.JSX.Element {
  const { onDone, onCancel, placeholder, cancelLabel } = props
  const [value, setValue] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    // Space clears the empty-submit confirmation (so typing resumes).
    if (input === ' ' && confirmEmpty) {
      setConfirmEmpty(false)
    }
  })

  const submit = (v: string): void => {
    const trimmed = v.trim()
    if (trimmed === '') {
      // Empty submit: first ask, second confirms (skips with empty custom).
      if (!confirmEmpty) {
        setConfirmEmpty(true)
        return
      }
      onDone('')
      return
    }
    onDone(trimmed)
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green" bold>{'❯ '}</Text>
        <CortexTextInput
          value={value}
          onChange={(v) => { setValue(v); setConfirmEmpty(false) }}
          onSubmit={submit}
          placeholder={placeholder ?? '输入回答… (Enter 提交)'}
          focus
        />
      </Box>
      <Text dimColor>
        {confirmEmpty
          ? '  ⚠️ 空提交 — 再按 Enter 确认留空，或继续输入'
          : `  Enter 提交 · Esc ${cancelLabel ?? '跳过此题'}`}
      </Text>
    </Box>
  )
}
