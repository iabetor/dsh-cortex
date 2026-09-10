/**
 * dsh-cortex help overlay — a full-screen reference for slash commands and
 * keybindings, opened with `/help` or `?`.
 *
 * The content is a plain data table (sections → rows) so the same list drives
 * the panel and can be unit-tested. Rendering is width-aware: a row's
 * description is truncated rather than allowed to soft-wrap, because ink only
 * measures explicit newlines and a wrapped row would smear the layout below it.
 *
 * @module dsh-cortex/tui/help-overlay
 */

import React, { useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'

/** One row inside a help section. */
export interface HelpRow {
  /** Left column: the command or key chord. */
  readonly key: string
  /** Right column: what it does. */
  readonly desc: string
}

/** One titled group of help rows. */
export interface HelpSection {
  readonly title: string
  readonly rows: readonly HelpRow[]
}

/**
 * The reference shown by the help overlay. Kept here (not in the runner) so the
 * panel is the single source of truth for user-facing docs.
 */
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: '输入与发送',
    rows: [
      { key: 'Enter', desc: '空闲时发送；agent 运行中插入当前回合（steer）' },
      { key: 'Tab', desc: '空闲时发送；agent 运行中排队，等本回合结束后依次发送' },
      { key: 'Esc', desc: '取消当前回合（保留已排队内容）' },
      { key: 'Ctrl+C', desc: '取消当前回合 / 退出' },
    ],
  },
  {
    title: '输入框编辑',
    rows: [
      { key: 'Ctrl+U', desc: '删除光标前整行（在末尾按即清空草稿）' },
      { key: 'Ctrl+K', desc: '删除光标到行尾' },
      { key: 'Ctrl+W', desc: '删除前一个词' },
      { key: 'Alt+D', desc: '删除后一个词' },
      { key: 'Ctrl+A / Ctrl+E', desc: '移到行首 / 行尾' },
      { key: 'Ctrl+B / Ctrl+F', desc: '左移 / 右移一个字符' },
      { key: '↑ / ↓', desc: '输入框为空时翻历史输入；否则移动光标' },
    ],
  },
  {
    title: '会话与模型',
    rows: [
      { key: '/model [名称]', desc: '查看或切换模型（无参数打开选择器）' },
      { key: '/effort [级别]', desc: '查看或设置推理强度 low|medium|high|xhigh|max' },
      { key: '/image <路径>', desc: '读取本地图片交给模型分析' },
      { key: '/bash [关键字]', desc: '查看本会话的 bash 输出（可过滤）' },
    ],
  },
  {
    title: '权限（沙箱）',
    rows: [
      { key: '/perm', desc: '显示当前权限模式与调整提示' },
      { key: '/readonly', desc: '只读：可读任意位置，禁止写入' },
      { key: '/restrict', desc: '工作区可写：仅当前工作区可写（默认）' },
      { key: '/full', desc: '完全权限：不再受限（谨慎使用）' },
    ],
  },
  {
    title: '视图与退出',
    rows: [
      { key: 'Ctrl+O', desc: '打开/关闭完整转录（工具输出与思考）' },
      { key: '/help 或 ?', desc: '打开本帮助面板' },
      { key: '/quit 或 /exit', desc: '退出 cortex' },
    ],
  },
]

/** Props for the help overlay. */
export interface HelpOverlayProps {
  /** Called when the panel should close. */
  onClose: () => void
}

/** Display width of one string (CJK/emoji count double). */
function sw(s: string): number {
  return stringWidth(s)
}

/** Truncate to a DISPLAY width, appending an ellipsis when cut. */
function truncate(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (sw(s) <= maxWidth) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = sw(ch)
    if (w + cw > maxWidth - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

/** Flatten the sections into the display rows the panel scrolls through. */
export function helpLines(sections: readonly HelpSection[], width: number): string[] {
  const lines: string[] = []
  // Key column width: the widest key in any section, capped so a long command
  // spelling cannot squeeze the descriptions away.
  const keyWidth = Math.min(
    22,
    sections.reduce((max, s) => Math.max(max, ...s.rows.map(r => sw(r.key))), 0),
  )
  for (const section of sections) {
    if (lines.length > 0) lines.push('')
    lines.push(`▌ ${section.title}`)
    for (const row of section.rows) {
      const pad = ' '.repeat(Math.max(0, keyWidth - sw(row.key)))
      const descWidth = Math.max(8, width - keyWidth - 8)
      lines.push(`  ${row.key}${pad}  ${truncate(row.desc, descWidth)}`)
    }
  }
  return lines
}

/**
 * Full-screen help panel. ↑/↓/PgUp/PgDn scroll, `q`/Esc/`?` closes.
 */
export function HelpOverlay(props: HelpOverlayProps): React.JSX.Element {
  const { onClose } = props
  const { stdout } = useStdout()
  const columns = stdout.columns || 80
  const rows = stdout.rows || 24
  // Header (1) + footer hint (1) + border (2).
  const viewportHeight = Math.max(5, rows - 4)
  const lines = helpLines(HELP_SECTIONS, Math.max(20, columns - 6))
  const maxOffset = Math.max(0, lines.length - viewportHeight)
  const [offset, setOffset] = useState(0)

  useInput((input, key) => {
    if (key.upArrow || key.pageUp) {
      setOffset(o => Math.max(0, o - (key.pageUp ? viewportHeight : 1)))
      return
    }
    if (key.downArrow || key.pageDown) {
      setOffset(o => Math.min(maxOffset, o + (key.pageDown ? viewportHeight : 1)))
      return
    }
    if (key.home) {
      setOffset(0)
      return
    }
    if (key.end) {
      setOffset(maxOffset)
      return
    }
    if (key.escape || input === 'q' || input === '?') onClose()
  })

  const visible = lines.slice(offset, offset + viewportHeight)
  const percent = lines.length === 0
    ? 100
    : Math.min(100, Math.round(((offset + viewportHeight) / lines.length) * 100))

  return (
    <Box flexDirection="column" height="100%" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>cortex 帮助</Text>
        <Text dimColor>  ↑/↓/PgUp/PgDn 滚动 · q/Esc 关闭</Text>
        <Box flexGrow={1} />
        <Text dimColor>{percent}%</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visible.map((line, i) => (
          <Text key={offset + i} color={line.startsWith('▌') ? 'cyan' : undefined} bold={line.startsWith('▌')}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
