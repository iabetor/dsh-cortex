#!/usr/bin/env node
/**
 * cortex — 启动命令包装。
 *
 * cortex 本体是 dsh 的一个 profile 插件（见 cordis.patch.yml），不是独立
 * 程序：这个脚本把 `cortex [args]` 转成 `dsh --profile cortex [args]`，
 * 让安装后的启动命令就是 `cortex`，与产品名一致。
 *
 * 用法：
 *   cortex                    进入交互 REPL
 *   cortex "任务描述"          一次性执行并打印答案
 *   cortex --resume           选择会话恢复（picker）
 *   cortex --last             恢复当前目录最近会话
 *
 * 其余参数原样透传给 dsh。退出码与信号一并透传。
 *
 * 说明：本文件是纯 JavaScript（node 直接执行，不经过构建），因此不写
 * TypeScript 语法。
 *
 * @module cortex/bin
 */

import { spawn } from 'node:child_process'

/** dsh 可执行名（PATH 上查找，pnpm/npm 全局安装均适用）。 */
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'

const args = ['--profile', 'cortex', ...process.argv.slice(2)]

const child = spawn(DSH_BIN, args, {
  stdio: 'inherit',
  // cortex 是 TUI：保持真实终端，不接管 stdin/stdout。
  env: process.env,
})

/** 以信号终止时的惯例退出码（128 + signo）。 */
const SIGNAL_CODES = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }

// 信号透传：Ctrl+C 等交给子进程处理，父进程只负责收尾。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    process.stderr.write(
      `cortex: 找不到命令 "${DSH_BIN}"。请先安装 DeepSeek Harness CLI，`
      + '或用 DSH_BIN 环境变量指定 dsh 的路径。\n',
    )
  } else {
    process.stderr.write(`cortex: 启动失败: ${error.message}\n`)
  }
  process.exit(127)
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.exit(128 + (SIGNAL_CODES[signal] ?? 0))
  }
  process.exit(code ?? 0)
})
