// An in-memory host for hark's tests: a fake Hark server, file system, keychain and UI.
import type { On } from 'claude-code'

export const ENDPOINT = 'https://harkstudio.io/mcp'
export const ROOT = '/work'
export const UUID = 'b409db7e-ea4c-4229-8a55-03eab8865d8f'
export const RUNTIME = '2.1.288'
export const STARTED = 1791061331000 // the conversation's first launch, as $.session.usage().startedAt reports it
export const HOME = '/home/me'

/** The conversation key hark derives: the first 16 bytes of SHA-256(root + '#' + startedAt), in hex. */
export async function keyOf(root = ROOT, started = STARTED): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${root}#${started}`))
  return [...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export const stateFile = (key: string) => `${HOME}/.claude/hark/${key}.json`
// The plugin's own manifest as the host returns it (the test environment has no file system).
export const MANIFEST = { name: 'hark', version: '0.1.0' }

// The compact brief, shaped like a real get_agent_brief reply.
export const BRIEF = {
  session_id: 'edb113d4-dd72-4b4c-b328-d3d4253cefaf',
  depth: 'compact',
  how_to_use: 'This is the compact brief. Call end_session before you stop.',
  identity: 'stx ditto (V-012) · stage live',
  handoff: { status: 'open', session_id: 'edb113d4-dd72-4b4c-b328-d3d4253cefaf', draft: null as unknown },
  build_state: {
    current_phase: 'beta',
    summary: 'Shipping copy trades',
    next_up: ['Wire Rialto swaps', 'Polish receipts'],
    blockers: ['Rialto API key pending'],
    non_goals: ['No custodial wallets (scope: src/wallet/**)', 'No mobile app'],
  },
  recent_decisions: [{ id: 'd1', title: 'Use Uniswap deep links', rationale: 'Stays non-custodial' }],
  open_candidates: 2,
  unreviewed: { items: [] },
}

// Decision entries shaped like Hark's list_journal_entries (fields trimmed). Hark's structured scope is scope_area;
// the text convention, "(scope: …)" in a title or a "scope:" body line, covers records without one.
export const DECISIONS = {
  entries: [
    { id: 'd2', kind: 'decision', title: 'Raw SQL, no ORM (scope: src/db/**)', body: 'We write queries by hand.', rationale: 'Queries stay reviewable', status: 'accepted', acceptance: 'accepted', applicability: 'current', scope_area: [], scope_audience: 'internal' },
    { id: 'd3', kind: 'decision', title: 'Unscoped call', body: null, rationale: 'Applies everywhere', status: 'accepted', acceptance: 'accepted', scope_area: [] },
    { id: 'd4', kind: 'decision', title: 'Use Stripe Checkout, with 20% deposits', body: null, rationale: 'Clean refunds', status: 'candidate', acceptance: 'proposed', applicability: 'current', scope_area: ['billing'] },
    { id: 'd5', kind: 'decision', title: 'Stripe is the only processor', body: 'One reconciliation path.\nscope: billing', rationale: null, acceptance: 'accepted' },
    { id: 'd6', kind: 'decision', title: 'Infra via Terraform (scope: deploy/**)', rationale: 'Reviewable infra', acceptance: 'accepted', scope_area: ['infra'], scope_audience: 'internal' },
    { id: 'd7', kind: 'decision', title: 'Old queue (scope: src/**)', rationale: 'Replaced', acceptance: 'accepted', applicability: 'superseded' },
  ],
}

type Reply = { status?: number; result?: unknown; isError?: boolean; text?: string; headers?: Record<string, string> }
export type Call = { url: string; method: string; tool?: string; args: Record<string, unknown>; headers: Record<string, string>; body: string }
type Bash = { result: Record<string, unknown>; isError?: boolean }

export const rpc = (id: number, result: unknown, isError = false) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError } })

/** Seats the host beneath the plugin. `hark` answers each tools/call by tool name; undefined means 503. */
export function world(
  on: On,
  opts: {
    cwd?: string
    project?: string | null
    files?: Record<string, string>
    sessionId?: string
    started?: () => number
    hark?: (tool: string, args: Record<string, unknown>, call: Call) => Reply | undefined | Promise<Reply | undefined>
    keychain?: string
    answer?: (question: string) => string | null
    bash?: (command: string) => Bash
  } = {},
) {
  const w = {
    calls: [] as Call[], reads: [] as string[], writes: [] as string[], runs: [] as string[][], dirs: new Set<string>(), lockTimes: new Map<string, number>(), statuses: [] as (string | undefined)[], logs: [] as string[],
    asks: [] as { question: string; header?: string; options: string[] }[], invalidated: [] as string[], commands: [] as string[],
  }
  const tools = () => w.calls.map(c => c.tool)
  const sent = () => w.calls.map(c => c.body).join('\n')

  on('session.root', () => ({ value: opts.cwd ?? ROOT }))
  const files: Record<string, string> = opts.files ?? (opts.project === null ? {} : { [`${ROOT}/.hark/project`]: opts.project ?? 'V-012\n' })
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify(MANIFEST) }
    return e.path in files ? { value: files[e.path] as string } : { deny: `ENOENT: ${e.path}` }
  })
  on('session.version', () => ({ value: { version: RUNTIME, base: RUNTIME } }))
  on('session.usage', () => ({ value: { startedAt: opts.started?.() ?? STARTED } as never }))
  on('session.id', () => ({ value: opts.sessionId ?? 'sess-1' }))
  on('fs.write', ($, e) => ((files[e.path] = e.text), w.writes.push(e.path), { value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files || w.dirs.has(e.path) }))
  on('fs.stat', ($, e) =>
    w.dirs.has(e.path) ? { value: { kind: 'dir' as const, size: 0, mtimeMs: w.lockTimes.get(e.path) ?? 0, isLink: false } } : { deny: `ENOENT: ${e.path}` })
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const target = e.argv.at(-1) ?? ''
    if (e.argv[0] === 'mkdir' && e.argv.includes('-p')) return w.dirs.add(target), done(0)
    if (e.argv[0] === 'mkdir') return w.dirs.has(target) ? done(1) : (w.dirs.add(target), done(0))
    if (e.argv[0] === 'tail') return target in files ? done(0, (files[target] ?? '').slice(-Number(e.argv[2]))) : done(1)
    const found = e.argv[0] === 'security' && opts.keychain !== undefined
    const exitCode = e.argv[0] === 'security' || e.argv[0] === 'secret-tool' ? (found ? 0 : 44) : 0
    return { value: { exitCode, stdout: found ? `${opts.keychain}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
    const body = e.init?.body ?? '{}'
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    const call: Call = { url: e.url, method: msg.method, tool: msg.params?.name, args: msg.params?.arguments ?? {}, headers: e.init?.headers ?? {}, body }
    w.calls.push(call)
    const r = await opts.hark?.(call.tool ?? '', call.args, call)
    const status = r?.status ?? (r ? 200 : 503)
    const text = r?.text ?? (r && 'result' in r ? rpc(msg.id ?? 0, r.result, r.isError) : '')
    return { value: { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json', ...r?.headers }, text } }
  })

  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (w.logs.push(e.text), { value: undefined }))
  on('ui.invalidate', ($, e) => (w.invalidated.push(e.event), { value: undefined }))
  on('command.register', ($, e) => (w.commands.push(e.name), { value: { command: e.name } }))

  // The engine's own bottoms for the events the tests raise.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.SessionEnd', () => ({}))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]
    w.asks.push({ question: q?.question ?? '', header: q?.header, options: (q?.options ?? []).map(x => x.label) })
    const answer = opts.answer ? opts.answer(q?.question ?? '') : 'Allow'
    return answer === null ? { deny: 'dismissed' } : { result: { questions: e.questions, answers: { [q?.question ?? '']: answer } } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    const r = opts.bash?.(e.command) ?? { result: { stdout: '', stderr: '', interrupted: false } }
    return (r.isError ? { isError: true, result: r.result, text: 'failed' } : { result: r.result, text: 'ok' }) as never
  })
  on('tool.call', ($, e) => ({ result: { ok: true }, text: `ran ${e.tool}` }) as never)

  return { ...w, files, tools, sent }
}

/** Answers every Hark tool the way a healthy server would, with end_session's real argument rules. */
export function healthy(tool: string, args: Record<string, unknown> = {}): Reply | undefined {
  if (tool === 'get_agent_brief') return { result: BRIEF }
  if (tool === 'list_journal_entries') return { result: DECISIONS }
  if (tool === 'list_candidates') return { result: { entries: [{ kind: 'decision', title: 'Adopt Rialto' }], build_state_fields: [{ field: 'blockers' }, { field: 'summary' }] } }
  if (tool === 'get_venture') return { result: { id: UUID, code: 'V-012' } }
  if (tool === 'end_session') {
    const required = ['venture', 'what_i_did', 'what_changed', 'whats_next'].every(k => typeof args[k] === 'string' && args[k] !== '')
    const links = (args.links as unknown[] | undefined) ?? []
    if (!required || links.length > 10) return { result: 'invalid arguments', isError: true }
  }
  return { result: { ok: true } }
}

export const SESSION = { cwd: ROOT, surface: 'terminal' as const, isInteractive: true }
export const END = (reason: 'prompt_input_exit' | 'clear' | 'resume' = 'prompt_input_exit') => ({ reason, sessionId: 's1', resume: { id: 's1' } })
export const COMMAND = (args: string) => ({ command: 'hark', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
export const TURN = (answer: string, extra: { agentId?: string; isAborted?: boolean; reason?: 'answer' | 'aborted' } = {}) =>
  ({ answer, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra })
export const MESSAGES = [{ role: 'user' as const, text: 'summary of the conversation', toolUses: [] }]
export const EDIT = (file: string, text = 'x') => ({ tool: 'Edit' as const, file_path: `${ROOT}/${file}`, old_string: 'a', new_string: text })
