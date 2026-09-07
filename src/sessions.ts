/**
 * dsh-cortex session discovery — lists persisted sessions grouped by working
 * directory, codex-style. dsh persists sessions under
 * `$DSH_HOME/sessions/<project-key>/<session-id>/`, where `<project-key>` is
 * derived from the session's cwd. Cortex scans the current cwd's project
 * directory and returns recent sessions newest-first for a resume picker.
 *
 * @module dsh-cortex/sessions
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

/** Environment variable that overrides the dsh home root. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the dsh home root. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Subdirectory under dsh home that holds persisted sessions. */
const SESSIONS_DIR_NAME = 'sessions'

/** Resolve the dsh home root: $DSH_HOME, else ~/.dsh. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DSH_HOME_ENV]
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/** Resolve the persisted-session root directory. */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), SESSIONS_DIR_NAME)
}

/**
 * Compute the human-navigable project directory key for a cwd, mirroring the
 * harness's `projectKey` in session-persistence-jsonl (format.ts): separators
 * become `-`, leading `-` runs are trimmed, unsafe code units become `~XXXX`,
 * and the result is wrapped in `--…--`. This is intentionally lossy like the
 * harness's own key, so only the current cwd's directory is scanned (never a
 * reverse decode).
 * @param cwd - absolute project directory.
 * @returns the filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** One discovered persisted session, newest-first ordering. */
export interface DiscoveredSession {
  /** The session id, usable with `agents.resume`. */
  readonly id: string
  /** Absolute path to the session's directory. */
  readonly dir: string
  /** Last-modified time of the session directory (ms epoch). */
  readonly mtimeMs: number
  /** Display title from the projection cache, when available. */
  readonly title?: string | undefined
}

/**
 * List persisted sessions whose cwd is `cwd`, newest first.
 * @param cwd - the working directory to group by (usually process.cwd()).
 * @param env - environment used to resolve the dsh home root.
 * @param limit - maximum number of sessions to return.
 */
export function listSessionsForCwd(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  limit = 20,
): DiscoveredSession[] {
  const project = join(sessionsRoot(env), projectKey(cwd))
  if (!existsSync(project)) return []
  // Only sessions attached to a workspace record for this cwd are resumable;
  // orphaned logs (never grouped, or grouping failed) are skipped so the
  // picker matches the web sidebar (no "未分组" sessions).
  const attached = workspaceSessionIdsForPath(cwd, env)
  // First pass: only sessions attached to this cwd's workspace record (so the
  // picker matches the web sidebar and never shows orphaned/ungrouped logs).
  let found = scanSessions(project, attached, env)
  // Fallback: when the workspace store has no record for this cwd (or lists
  // nothing), surface all physical sessions so a fresh install can still
  // resume its own history.
  if (found.length === 0) found = scanSessions(project, undefined, env)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, limit)
}

/** Scan one cwd's session directory, optionally filtered by an attach set. */
function scanSessions(
  project: string,
  attached: Set<string> | undefined,
  env: NodeJS.ProcessEnv,
): DiscoveredSession[] {
  const found: DiscoveredSession[] = []
  for (const entry of readdirSync(project, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(project, entry.name)
    const stat = statSync(dir)
    const hasLog = ['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl', 'session.v2.jsonl']
      .some(name => existsSync(join(dir, name)))
    if (!hasLog) continue
    if (attached !== undefined && !attached.has(entry.name)) continue
    found.push({
      id: entry.name,
      dir,
      mtimeMs: stat.mtimeMs,
      title: readProjectedTitle(entry.name, env),
    })
  }
  return found
}

/**
 * Read the set of session ids attached to the workspace record whose path
 * matches `cwd`, from the durable workspace store
 * (`$DSH_HOME/storages/workspace.json`). Returns undefined when the store is
 * missing/unreadable (callers then fall back to listing everything).
 */
function workspaceSessionIdsForPath(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Set<string> | undefined {
  try {
    const file = join(dshHome(env), 'storages', 'workspace.json')
    if (!existsSync(file)) return undefined
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[] }> }
    }
    const workspaces = data.tables?.workspaces
    if (workspaces === undefined) return undefined
    for (const record of Object.values(workspaces)) {
      if (record.path === cwd && Array.isArray(record.sessionIds)) {
        return new Set(record.sessionIds)
      }
    }
    return new Set() // cwd has a sessions dir but no workspace record
  } catch {
    return undefined
  }
}

/**
 * Read a session's display title from the projection cache
 * (`$DSH_HOME/storages/session_projcache/sessions/<id>.json` → `rows.title.val`),
 * when present. Returns undefined when the cache file is missing or malformed.
 */
function readProjectedTitle(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const file = join(dshHome(env), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    if (!existsSync(file)) return undefined
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      record?: { rows?: { title?: { val?: unknown } } }
    }
    const val = data.record?.rows?.title?.val
    return typeof val === 'string' && val !== '' ? val : undefined
  } catch {
    return undefined
  }
}

/** Format a relative timestamp for the picker list. */
export function relativeTime(epochMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - epochMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(epochMs).toLocaleDateString()
}
