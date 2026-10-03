// hark — shared project memory for Claude Code. MIT License.
// Every request this file sends is listed in README.md. It sends metadata only:
// never file contents, transcripts or secrets. Any Hark failure logs one line
// and lets the session carry on.
import type { EngineInterface, Register } from 'claude-code'

const APP = 'https://harkstudio.io'
const CLIENT = 'claude-code-mod' // X-Hark-Client header and params._meta.client on every request
const CODE = /\b(V-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const TESTS = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|(?:go|cargo|deno|mix|dotnet|swift|make)\s+test|python3?\s+-m\s+(?:pytest|unittest)|pytest|vitest|jest|mocha|rspec|phpunit|tox|claude\s+plugin\s+test)\b/
const NEXT = /^\W*(?:#+\s*)?(?:\*\*)?next (?:steps?|up)\b[^\w\n]*/i
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm
const SECRET = new RegExp([/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*-----|$)/, /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/,
  /\bA[KS]IA[0-9A-Z]{16}\b/, /\b(?:sk[-_]|[rp]k_(?:live|test)_|whsec_|hark_pat_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|npm_|AIza)[\w-]{10,}/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/, /\b\w*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)\w*\s*[=:]\s*[^\s`'",;]+/,
].map(r => r.source).join('|'), 'gi')
const INTRO = 'Hark project brief, read at session start. The hark plugin records the handoff (end_session) when this session ends, so you need not call it.'

type Rule = { id: string; title: string; why: string; scope: string[] }
type Activity = { files: Set<string>; commits: string[]; tests: string[]; links: string[]; notes: string }
type Hark = { ready: Promise<boolean> | null; root: string; code: string; token: string; agent: string; rpc: number; uuid: string
  brief: Promise<unknown> | null; recap: boolean; opened: boolean; rules: Promise<Rule[]> | null; retry: number
  allowed: Set<string>; handoff: 'Open' | 'Draft' | 'Clean'; needs: number; act: Activity; logged: Set<string> }
const activity = (): Activity => ({ files: new Set(), commits: [], tests: [], links: [], notes: '' })
const fresh = (): Hark => ({ ready: null, root: '', code: '', token: '', agent: '', rpc: 0, uuid: '', brief: null, recap: false, opened: false,
  rules: null, retry: 0, allowed: new Set(), handoff: 'Open', needs: 0, act: activity(), logged: new Set() })
const o = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])
const words = (v: unknown): string =>
  typeof v === 'string' ? v : [o(v).title ?? o(v).text ?? o(v).summary ?? o(v).name, o(v).why ?? o(v).rationale].filter(Boolean).join(' — ')
const bullets = (v: unknown, n = 20) => a(v).map(words).filter(Boolean).slice(0, n).map(x => `- ${x}`)
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120)
const parse = (text: string, fallback: unknown): unknown => { try { return JSON.parse(text) } catch { return fallback } }
const frame = (tag: string, code: string, body: string) => `<${tag} project="${code}">\n${body}\n</${tag}>`
// Agent notes leave the machine, so code blocks, credentials and the session's own key are cut out first.
const clean = (t: string, token: string) =>
  (token ? t.split(token).join('[redacted]') : t).replace(FENCE, '[code omitted]').replace(SECRET, '[redacted]').trim().slice(0, 1500)

export const register: Register = on => {
  let s = fresh()

  on('session.start', async ($, e, next) => {
    s = fresh()
    s.ready = boot($, s)
    const spec = { name: 'hark', description: 'Hark project memory: brief | handoff | needs | open', argumentHint: 'brief|handoff|needs|open' }
    await $.command.register(spec).catch(() => undefined)
    return next(e)
  })

  // 1 + 2. The brief rides the first message; after a compaction the engine re-reads this and gets the sub-brief.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const b = (await s.ready) ? await (s.brief ??= brief($, s)) : null
    if (b == null) return r
    const text = s.recap
      ? frame('hark-recap', s.code, `Plan carried over from Hark after compaction:\n${render(b, true)}`)
      : frame('hark-brief', s.code, `${INTRO}\n${typeof b === 'string' ? b : JSON.stringify(b)}`)
    return { ...r, blocks: [...r.blocks.filter(x => x.name !== 'hark'), { name: 'hark', text }] }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute' || !(await s.ready)) return next(e)
    const before = s.brief, after = brief($, s)
    const r = await next(e)
    if (r.skip !== undefined) return r
    Object.assign(s, { recap: true, brief: after.then(b => b ?? before), rules: null })
    $.ui.invalidate('prompt.context')
    return r
  })

  // 3. Guard edits inside the project against scoped decisions and non-goals; record what was touched.
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const x = e as unknown as Record<string, unknown>
    const path = String(x.file_path ?? x.notebook_path ?? '')
    if (!(await s.ready) || !path.startsWith(`${s.root}/`)) return next(e)
    const rel = path.slice(s.root.length + 1)
    const stop = await guard($, s, e.tool, rel, x)
    if (stop) return { deny: stop }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) s.act.files.add(rel)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !(await s.ready)) return ran
    const test = TESTS.exec(e.command)?.[0]
    const unsure = !ran.isError && (ran.result.backgroundTaskId !== undefined || ran.result.timedOutAfterMs !== undefined || e.command.includes('|'))
    if (test) s.act.tests.push(`${test}: ${ran.isError ? 'failed' : unsure ? 'result unknown' : 'passed'}`)
    if (ran.isError) return ran
    const op = ran.result.gitOperation, sha = op?.commit?.sha.slice(0, 7) ?? ''
    if (/^[0-9a-f]{7}$/.test(sha)) {
      const subject = new RegExp(`^\\[[^\\]\\n]*\\b${sha}[0-9a-f]*\\]\\s+(.+)$`, 'm').exec(ran.result.stdout)?.[1] ?? ''
      s.act.commits.push(`${sha} ${clean(subject, s.token).slice(0, 120)}`.trim())
    }
    if (op?.pr?.url) s.act.links.push(op.pr.url)
    return ran
  })

  // The agent wrote its own Hark handoff: don't record the same work twice.
  on('tool.call', { tool: /^mcp__.+__end_session$/ }, async ($, e, next) => {
    const ran = await next(e)
    const handedOff = typeof (e as unknown as Record<string, unknown>).what_i_did === 'string' && ran.deny === undefined && ran.isError !== true
    if (e.agentId === undefined && handedOff && (await s.ready)) show($, s, { act: activity(), handoff: 'Clean' })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const isSummary = e.agentId === undefined && e.reason === 'answer' && !e.isAborted && e.answer.trim() !== ''
    if (isSummary && (await s.ready)) s.act.notes = e.answer
    return next(e)
  })

  // 4. Hand off when the session ends (exit, /clear, resume, logout, signal).
  on('session.end', async ($, e, next) => {
    if (await s.ready) await handoff($, s, () => next.budget.remainingMs)
    if (e.reason === 'clear' || e.reason === 'resume') Object.assign(s, { brief: null, recap: false, rules: null, allowed: new Set() })
    return next(e)
  })

  // 5. /hark brief | handoff | needs | open
  on('command.run', { command: 'hark' }, async ($, e) => ({ text: await command($, s, e.args.trim().split(/\s+/)[0] || 'brief') }))
}

async function boot($: EngineInterface, s: Hark): Promise<boolean> {
  try {
    // .hark/project (or a .hark file) in the session's directory or the nearest one above it
    for (let dir = await $.session.root(); !s.code && dir; dir = dir.replace(/[\\/][^\\/]*$/, '')) {
      for (const file of ['.hark/project', '.hark']) s.code ||= CODE.exec(await $.fs.read(`${dir}/${file}`).catch(() => ''))?.[1] ?? ''
      s.root = dir
    }
    if (!s.code) return false
    s.token = (await $.env.get('HARK_TOKEN'))?.trim() || (await $.env.get('HARK_PAT'))?.trim()
      || (await run($, ['security', 'find-generic-password', '-s', 'hark', '-w']))
      || (await run($, ['secret-tool', 'lookup', 'service', 'hark'])) || ''
    if (!s.token) return note($, s, 'no access key; set HARK_TOKEN or HARK_PAT (or, on macOS and Linux, a "hark" keychain item)'), false
    // Requests name the mod and the engine: User-Agent hark-mod/<plugin.json version> (claude-code/<runtime version>)
    const manifest = o(parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => ''), null))
    const runtime = await $.session.version().then(v => v.version, () => 'unknown')
    s.agent = `hark-mod/${manifest.version ?? 'unknown'} (claude-code/${runtime})`
    s.brief = brief($, s)
    return true
  } catch (err) { return note($, s, `setup failed (${errText(err)})`), false }
}

// MCP over HTTP, stateless: each call is one JSON-RPC tools/call POST, as Hark's own hooks send it.
async function call($: EngineInterface, s: Hark, tool: string, args: Record<string, unknown>, ms = 3000): Promise<unknown> {
  const req = { jsonrpc: '2.0', id: ++s.rpc, method: 'tools/call', params: { name: tool, arguments: args, _meta: { client: CLIENT } } }
  const headers = {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.token}`,
    'user-agent': s.agent, 'x-hark-client': CLIENT,
  }
  const wait = Math.max(100, ms)
  const late = $.clock.sleep(wait).then(() => Promise.reject(new Error(`no reply in ${wait}ms`)), () => new Promise<never>(() => {}))
  const res = await Promise.race([$.http.fetch(`${APP}/mcp`, { method: 'POST', headers, body: JSON.stringify(req) }), late])
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // The reply is one JSON-RPC message, or an SSE stream whose data lines carry it.
  const frames = res.headers['content-type']?.includes('event-stream')
    ? res.text.split(/\r?\n\r?\n/).map(f => f.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'))
    : [res.text]
  const msg = frames.map(f => o(parse(f, null))).find(m => m.id === req.id) ?? {}
  if (msg.error) throw new Error(String(o(msg.error).message ?? 'JSON-RPC error'))
  if (!msg.result) throw new Error('unreadable reply')
  const r = o(msg.result)
  const text = a(r.content).map(b => o(b).text).filter(t => typeof t === 'string').join('\n')
  if (r.isError) throw new Error(text.slice(0, 120) || 'tool error')
  return r.structuredContent !== undefined ? r.structuredContent : parse(text, text)
}

// call(), except that a failure logs one line ("<what> (<error>)") and comes back as an Error instead of throwing.
async function attempt($: EngineInterface, s: Hark, what: string, tool: string, args: Record<string, unknown>, ms?: number): Promise<unknown> {
  try { return await call($, s, tool, args, ms) }
  catch (err) { return note($, s, `${what} (${errText(err)})`), new Error(errText(err)) }
}

async function brief($: EngineInterface, s: Hark): Promise<unknown> {
  const b = await attempt($, s, 'brief unavailable', 'get_agent_brief', { venture: s.code, depth: 'compact' })
  if (b instanceof Error) return $.ui.status(`Hark ${s.code} · offline`), null
  const h = o(o(b).handoff), pending = o(b).open_candidates
  const state = h.draft ? 'Draft' : /clean|closed|ended|confirmed/i.test(String(h.status ?? '')) ? 'Clean' : 'Open'
  show($, s, { opened: true, handoff: state, needs: typeof pending === 'number' ? pending : a(o(o(b).unreviewed).items).length })
  return b
}

function render(b: unknown, recap: boolean): string {
  if (typeof b === 'string') return b
  const st = o(o(b).build_state)
  const project = [o(b).identity, st.current_phase && `Phase: ${st.current_phase}`, st.summary].filter(Boolean).map(String)
  const sections = {
    Project: recap ? [] : project, 'Accepted decisions': bullets(o(b).recent_decisions), 'Non-goals': bullets(st.non_goals),
    Blockers: bullets(st.blockers), 'Next action': bullets(st.next_up, recap ? 1 : 5),
  }
  return Object.entries(sections).filter(([, l]) => l.length).map(([t, l]) => `${t}:\n${l.join('\n')}`).join('\n\n') || 'Nothing recorded yet.'
}

// Each edit asks with its own dialog: a hook waiting on another edit's question would outlive its time budget.
async function guard($: EngineInterface, s: Hark, tool: string, rel: string, x: Record<string, unknown>): Promise<string | null> {
  const edits = a(x.edits).map(o)
  const added = [x.new_string, x.content, x.new_source, ...edits.map(d => d.new_string)].filter(t => typeof t === 'string').join('\n')
  const removed = [x.old_string, ...edits.map(d => d.old_string)].filter(t => typeof t === 'string').join('\n')
  const hits = (await (s.rules ??= rules($, s))).filter(r => !s.allowed.has(r.id) && matches(r, rel, `${removed}\n${added}`))
  if (!hits.length) return null
  const count = (t: string) => (t ? t.split('\n').length : 0)
  const summary = `${tool} ${rel} (-${count(removed)} +${count(added)} lines)`
  const reasons = hits.map(h => `${h.title} covers this edit.\nWhy: ${h.why}`).join('\n\n')
  const answer = await $.ui.ask(`${reasons}\n\n${summary}\n\nAllow it?`, { header: 'Hark', options: ['Allow', 'Stop'] }).then(t => t.trim(), () => '')
  if (answer === '') return note($, s, `could not ask about ${hits.map(h => h.title).join(', ')}; the edit went ahead`), null
  if (answer === 'Allow') return hits.forEach(h => s.allowed.add(h.id)), null
  const said = answer === 'Stop' ? '' : ` The user said: "${answer}".`
  const why = hits.map(h => `${h.title} (${h.why})`).join('; ')
  return `Stopped by the user: ${summary} conflicts with Hark ${why}.${said} Do not retry it; ask the user how to proceed.`
}

// Scoped records for the guard. A failed decision fetch is retried a minute later, not on every edit.
async function rules($: EngineInterface, s: Hark): Promise<Rule[]> {
  const nonGoals = a(o(o(await s.brief).build_state).non_goals).flatMap(v => asRule('Non-goal', v))
  if ((await $.clock.now()) >= s.retry) {
    const args = { venture: s.code, kind: 'decision', limit: 200 }
    const journal = await attempt($, s, 'decisions unavailable for the edit check', 'list_journal_entries', args)
    if (!(journal instanceof Error)) return [...nonGoals, ...a(o(journal).entries).flatMap(v => asRule('Decision', v))]
    s.retry = (await $.clock.now()) + 60_000
  }
  s.rules = null // keep only a complete list for the session
  return nonGoals
}

// A settled record's scope: Hark's structured field when it has one, else a "(scope: src/db/**, billing)" title marker or a "scope: ..." body line.
function asRule(kind: string, v: unknown): Rule[] {
  const x = o(v), name = typeof v === 'string' ? v : x.title
  const fields = [x.scope_area, x.scope_paths, x.scope, x.scopes, x.paths, x.files, x.areas, x.area, x.applies_to]
    .flatMap(y => (y && typeof y === 'object' && !Array.isArray(y) ? Object.values(y).flat() : a(y)))
  const line = /^\s*(?:scope|areas?|paths?|files?)\s*:\s*(.+)$/im.exec(`${x.body ?? ''}\n${x.rationale ?? ''}`)?.[1]
  const titled = /\b(?:scope|areas?|paths?|files?)\s*:\s*([^)\]\n]+)/i.exec(String(name ?? ''))?.[1]
  const marked = [titled, line].flatMap(m => m?.split(/[,\s]+/) ?? [])
  const scope = (fields.length ? fields : marked).filter((p): p is string => typeof p === 'string').map(p => p.trim())
    .filter(p => p.length > 2 && !/^(?:and|the|for|all|any|not)$/i.test(p))
  const unsettled = /propos|candidate|reject|supersed|draft|pending|retir|expir|obsolete/i.test(`${x.status ?? ''} ${x.acceptance ?? ''} ${x.applicability ?? ''}`)
  if (!scope.length || unsettled || x.superseded_by || x.accepted === false) return []
  const title = String(name ?? x.summary ?? 'Untitled').replace(/\s*[([]?\b(?:scope|areas?|paths?|files?)\s*:.*$/i, '')
  const why = String(x.why ?? x.rationale ?? x.body ?? '').replace(/^\s*(?:scope|areas?|paths?|files?)\s*:.*$/gim, '').trim().slice(0, 300)
  return [{ id: String(x.id ?? `${kind}:${title}`), title: `${kind} "${title}"`, why: why || 'No rationale recorded.', scope }]
}

// A scope with / * ? or . is a path glob; a bare word is an area, matched as a whole word in the path or the diff.
function matches(rule: Rule, path: string, diff: string): boolean {
  return rule.scope.some(p => {
    const word = p.replace(/[^\w-]/g, '')
    if (!/[/*?.]/.test(p)) return word !== '' && new RegExp(`\\b${word}\\b`, 'i').test(`${path}\n${diff}`)
    const glob = p.replace(/^\.?\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')
    return new RegExp(`(^|/)${glob}($|/)`).test(path)
  })
}

// end_session, or session_stopped when Hark answered with an error and time remains. A timeout is not retried.
async function handoff($: EngineInterface, s: Hark, left: () => number): Promise<string> {
  const ms = () => left() - 400 // leave the rest of the exit window to the hooks after this one
  const act = s.act
  s.act = activity()
  if (act.files.size + act.commits.length + act.tests.length === 0) {
    const reason = 'Claude Code session with no edits, commits or test runs'
    if (s.opened) await attempt($, s, 'close_session failed', 'close_session', { reason }, ms())
    s.opened = false
    return 'Nothing to hand off: no edits, commits or test runs in this session.'
  }
  const ended = await attempt($, s, 'end_session failed', 'end_session', handoffArgs(s, act), ms())
  if (!(ended instanceof Error)) return show($, s, { handoff: 'Clean', opened: false }), `Handoff saved to Hark (${s.code}).`
  if (ended.message.startsWith('no reply') || ms() < 100) return `Hark did not take the handoff (${ended.message}).`
  const stopped = await attempt($, s, 'session_stopped failed', 'session_stopped', { venture: s.code }, ms())
  if (stopped instanceof Error) return `Hark is unreachable; no handoff was recorded (${stopped.message}).`
  return show($, s, { handoff: 'Draft', opened: false }), 'Hark could not take the handoff, so it will draft one from repo activity.'
}

function handoffArgs(s: Hark, act: Activity) {
  const notes = clean(act.notes, s.token)
  const lines = notes.split('\n'), at = lines.findIndex(l => NEXT.test(l))
  const nextUp = at < 0 ? '' : lines.slice(at, at + 6).join('\n').replace(NEXT, '').trim().split(/\n\s*\n/)[0] ?? ''
  const failing = act.tests.filter(t => t.endsWith('failed')).join('; ')
  const files = [...act.files]
  const counts = `Claude Code session: ${files.length} file(s) edited, ${act.commits.length} commit(s), ${act.tests.length} test run(s).`
  const review = `Review this session's changes${files.length ? ` to ${files.slice(0, 3).join(', ')}` : ''}.`
  return {
    venture: s.code,
    what_i_did: [counts, ...act.tests.map(t => `Tests ${t}`), notes && `Agent notes:\n${notes}`].filter(Boolean).join('\n'),
    what_changed: [...files.map(f => `edited ${f}`), ...act.commits.map(c => `commit ${c}`)].slice(0, 60).join('\n') || 'No file edits or commits recorded.',
    whats_next: nextUp.trim() || (failing ? `Fix the failing test runs: ${failing}` : review),
    links: [...act.links, ...files].slice(0, 10),
    ...(failing ? { watch_out_for: `Failing test runs: ${failing}` } : {}),
  }
}

async function command($: EngineInterface, s: Hark, sub: string): Promise<string> {
  if (!(await s.ready)) return 'Hark is not set up here: run `hark init`, then set HARK_TOKEN (or HARK_PAT) or add a "hark" keychain item.'
  if (sub === 'handoff') return handoff($, s, () => 3400)
  if (sub === 'brief') {
    const b = (await brief($, s)) ?? (await s.brief)
    return b == null ? 'Hark is unreachable right now.' : `**Hark ${s.code}** · ${s.handoff} · ${s.needs} need you\n\n${render(b, false)}`
  }
  if (sub === 'needs') {
    const r = await attempt($, s, 'needs unavailable', 'list_candidates', { venture: s.code })
    if (r instanceof Error) return 'Hark is unreachable right now.'
    const proposals = a(o(r).entries).map(v => `- ${o(v).kind ?? 'proposal'}: ${words(v)}`)
    const items = [...proposals, ...a(o(r).build_state_fields).map(v => `- proposed ${o(v).field ?? words(v)}`)]
    show($, s, { needs: items.length })
    return items.length ? `**${items.length} need you** (review at ${APP})\n${items.join('\n')}` : 'Nothing needs you.'
  }
  if (sub !== 'open') return 'Usage: /hark brief | handoff | needs | open'
  const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
  if (!s.uuid && isId(s.code)) s.uuid = s.code
  if (!s.uuid) {
    const v = await attempt($, s, 'project link unavailable', 'get_venture', { id_or_code: s.code })
    if (!(v instanceof Error)) s.uuid = [o(v).id, o(o(v).venture).id].find(isId) ?? ''
  }
  const url = s.uuid ? `${APP}/ventures/${s.uuid}` : `${APP}/studio`
  const opened = (await run($, ['open', url])) !== null || (await run($, ['xdg-open', url])) !== null
  return `${opened ? 'Opened' : 'Open'} [${s.code} on Hark](${url})`
}

// A host command's trimmed stdout, or null when it is missing, fails or times out.
async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  const r = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.trim() : null
}

// Apply a change to the session's state, then refresh the status line.
function show($: EngineInterface, s: Hark, change: Partial<Hark>) {
  Object.assign(s, change)
  $.ui.status(`Hark ${s.code} · ${s.handoff} · ${s.needs} need you`)
}

function note($: EngineInterface, s: Hark, text: string) {
  if (!s.logged.has(text)) $.ui.log(`hark: ${text}`)
  s.logged.add(text)
}
