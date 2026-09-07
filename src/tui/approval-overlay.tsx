/**
 * dsh-cortex approval overlay — renders one sandbox-approval request in the
 * terminal. The agent (write/edit/bash) wants to act outside the current
 * workspace sandbox; the human decides:
 *   y      → allow (this call; the same tool+reason is auto-allowed for the
 *            rest of this session — cortex-side allowlist)
 *   n      → reject (optionally with a reason typed back to the model)
 *   Esc/q  → cancel (abort the request)
 *
 * @module dsh-cortex/tui/approval-overlay
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { CortexTextInput } from './text-input.tsx'
import type { ApprovalRequest, ApprovalOutcome } from '../driver.ts'

/** Props for the approval overlay. */
export interface ApprovalOverlayProps {
  approval: ApprovalRequest
  /** Call with the human's decision (reason only for rejected). */
  onDecision: (outcome: ApprovalOutcome, reason?: string) => void
}

/** Pre-wrap text into display lines at a fixed width. */
function splitText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.length <= width) lines.push(raw)
    else for (let i = 0; i < raw.length; i += width) lines.push(raw.slice(i, i + width))
  }
  return lines
}

type Phase = 'decide' | 'reason'

/**
 * Approval overlay: shows what the agent wants to do outside the sandbox and
 * asks y / n. Rejecting with n enters a short reason input (optional; Enter
 * with empty text rejects without a reason).
 */
export function ApprovalOverlay(props: ApprovalOverlayProps): React.JSX.Element {
  const { approval, onDecision } = props
  const [phase, setPhase] = useState<Phase>('decide')
  const [reason, setReason] = useState('')
  const width = Math.max(30, (process.stdout.columns ?? 80) - 8)

  useInput((input, key) => {
    if (phase === 'reason') return // reason phase handled by CortexTextInput
    if (input === 'y' || input === 'Y') {
      onDecision('allowed-once', undefined)
      return
    }
    if (input === 'n' || input === 'N') {
      setPhase('reason')
      return
    }
    if (key.escape || input === 'q') {
      onDecision('cancelled', undefined)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Box>
        <Text color="yellow" bold>{'🔐 授权请求'}</Text>
        <Text dimColor>  工作区外操作</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>{approval.toolName}</Text>
        {approval.reason !== undefined && approval.reason !== '' && (
          splitText(approval.reason, width).map((l, i) => <Text key={`r${i}`}>{l}</Text>)
        )}
      </Box>
      {phase === 'decide' && (
        <Box flexDirection="column">
          <Text>
            <Text color="green" bold>[y]</Text> 允许(本会话相同操作免问)
          </Text>
          <Text>
            <Text color="red" bold>[n]</Text> 拒绝
            {''}   <Text dimColor>[q/Esc] 取消</Text>
          </Text>
        </Box>
      )}
      {phase === 'reason' && (
        <Box flexDirection="column">
          <Box>
            <Text color="red" bold>{'拒绝理由(可选): '}</Text>
            <CortexTextInput
              value={reason}
              onChange={setReason}
              onSubmit={(v) => {
                onDecision('rejected', v.trim() === '' ? undefined : v.trim())
              }}
              placeholder="Enter 直接拒绝;输入理由会回给模型"
              focus
            />
          </Box>
          <Text dimColor>  Enter 提交拒绝 · Esc 取消</Text>
        </Box>
      )}
    </Box>
  )
}
