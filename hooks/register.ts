// hark — shared project memory for Claude Code. MIT License.
// Every request this file sends is listed in README.md. It sends metadata only:
// never file contents, transcripts or secrets. Any Hark failure logs one line
// and lets the session carry on.
import type { EngineInterface, Register } from 'claude-code'

const CLIENT = 'claude-code-mod' // X-Hark-Client header and params._meta.client on every request
const CONFIGURE = '/plugin configure hark-memory@hark (hark-memory@synced if you added it from the Claude directory)'
const CODE = /\b(V-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const TESTS = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|(?:go|cargo|deno|mix|dotnet|swift|make)\s+test|python3?\s+-m\s+(?:pytest|unittest)|pytest|vitest|jest|mocha|rspec|phpunit|tox|claude\s+plugin\s+test)\b/
const NEXT = /^\W*(?:#+\s*)?(?:\*\*)?next (?:steps?|up)\b[^\w\n]*/i
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm
const SECRET = new RegExp([/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*-----|$)/, /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/,
  /\bA[KS]IA[0-9A-Z]{16}\b/, /\b(?:sk[-_]|[rp]k_(?:live|test)_|whsec_|hark_pat_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|npm_|AIza)[\w-]{10,}/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/, /\b\w*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)\w*\s*[=:]\s*[^\s`'",;]+/,
].map(r => r.source).join('|'), 'gi')
const INTRO = 'Hark project brief, read at session start. The hark plugin records the handoff (end_session) when this session ends, so you need not call it.'
const STATE_FRESH_MS = 30 * 60_000 // another process reuses the conversation's brief while its state is younger than this
const LOCK_STALE_MS = 30_000 // a handoff claim older than any handoff takes was left by a process that died mid-handoff
const KEEP_MS = 14 * 24 * 60 * 60_000 // conversation records and cached briefs are dropped from the store after this
const EXIT_WRITE_MS = 150 // longest a store write may hold up a handoff: Claude Code waits up to ~0.7 s for the store's lock

type Rule = { id: string; title: string; why: string; paths: string[]; areas: string[] }
// One conversation's state, kept in the plugin's own store ($.store, which Claude Code saves) so that every process carrying the
// conversation (Claude Code moves one into a background process; --resume starts another) shares it. Each process writes only its
// own record, "c:<conversation key>:<start>:<random>", and reads merge them all. A segment is the work between handoffs.
// `id` is random, sent to Hark as params._meta.conversation; the conversation key is a local hash Hark never sees.
type Conversation = {
  id: string; latest: string; segment: number; closed: boolean; opened: boolean; updatedAt: number; briefAt: number
  recap: boolean; handoff: 'Open' | 'Draft' | 'Clean'; needs: number; notes: string
  files: string[]; commits: string[]; tests: string[]; links: string[]; allowed: string[]; sessions: string[]
}
type Hark = { ready: Promise<boolean> | null; root: string; code: string; token: string; agent: string; rpc: number; uuid: string
  key: string; record: string; shared: boolean; saving: Promise<void>; session: string; moved: boolean; prompted: boolean
  brief: Promise<unknown> | null; rules: Promise<Rule[]> | null; retry: number; c: Conversation; logged: Set<string> }
const LISTS = ['files', 'commits', 'tests', 'links', 'allowed', 'sessions'] as const
const conversation = (): Conversation => ({ id: '', latest: '', segment: 0, closed: false, opened: false, updatedAt: 0,
  briefAt: 0, recap: false, handoff: 'Open', needs: 0, notes: '', files: [], commits: [], tests: [], links: [], allowed: [], sessions: [] })
const fresh = (): Hark => ({ ready: null, root: '', code: '', token: '', agent: '', rpc: 0, uuid: '', key: '', record: '', shared: false, saving: Promise.resolve(), session: '',
  moved: false, prompted: false, brief: null, rules: null, retry: 0, c: conversation(), logged: new Set() })
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const add = (list: string[], value: string) => { if (!list.includes(value)) list.push(value) }
const busy = (c: Conversation) => c.files.length + c.commits.length + c.tests.length > 0
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

// Module scope holds constants only: setting a new access key reloads the plugin, and register runs again with it.
export const register: Register = (on, options) => {
  // The access key is the plugin's sensitive userConfig option: Claude Code keeps it in its secure storage, never hark.
  const accessKey = typeof options.access_key === 'string' ? options.access_key.trim() : ''
  let s = fresh()

  on('session.start', async ($, e, next) => {
    if (!(await placeholder($))) s.ready ??= boot($, s, accessKey)
    const spec = { name: 'hark', description: 'Hark project memory: brief | handoff | needs | open', argumentHint: 'brief|handoff|needs|open' }
    await $.command.register(spec).catch(() => undefined)
    return next(e)
  })

  // 1 + 2. The brief rides the first message; after a compaction the engine re-reads this and gets the sub-brief.
  // A background process rebuilds the conversation's context before its session.start, so this may start hark itself.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!s.prompted && (await placeholder($))) return r
    const b = (await (s.ready ??= boot($, s, accessKey))) ? await (s.brief ??= brief($, s)) : null
    if (b == null) return r
    const text = s.c.recap
      ? frame('hark-recap', s.code, `Plan carried over from Hark after compaction:\n${render(b, true)}`)
      : frame('hark-brief', s.code, `${INTRO}\n${typeof b === 'string' ? b : JSON.stringify(b)}`)
    return { ...r, blocks: [...r.blocks.filter(x => x.name !== 'hark'), { name: 'hark', text }] }
  })

  // The agent view's empty placeholder session makes no Hark call until someone gives it a task.
  // The process that got the latest prompt is the one carrying the conversation (see session.end).
  on('prompt.submit', async ($, e, next) => {
    if (!s.prompted && (await placeholder($))) $.ui.invalidate('prompt.context')
    s.prompted = true
    if (s.ready && (await s.ready)) await soon($, save($, s, c => { c.latest = s.session }))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute' || !(await s.ready)) return next(e)
    const before = s.brief, after = brief($, s)
    const r = await next(e)
    if (r.skip !== undefined) return r
    Object.assign(s, { brief: after.then(b => b ?? before), rules: null })
    await save($, s, c => { c.recap = true })
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
    if (ran.deny === undefined && ran.isError !== true) await record($, s, c => add(c.files, rel))
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !(await s.ready)) return ran
    const test = TESTS.exec(e.command)?.[0]
    const out = ran.isError ? null : ran.result
    const unsure = out !== null && (out.backgroundTaskId !== undefined || out.timedOutAfterMs !== undefined || e.command.includes('|'))
    const sha = out?.gitOperation?.commit?.sha.slice(0, 7) ?? '', pr = out?.gitOperation?.pr?.url
    const subject = /^[0-9a-f]{7}$/.test(sha) ? new RegExp(`^\\[[^\\]\\n]*\\b${sha}[0-9a-f]*\\]\\s+(.+)$`, 'm').exec(out?.stdout ?? '')?.[1] ?? '' : null
    if (!test && subject === null && !pr) return ran
    await record($, s, c => {
      if (test) c.tests.push(`${crypto.randomUUID().slice(0, 8)} ${test}: ${out === null ? 'failed' : unsure ? 'result unknown' : 'passed'}`)
      if (subject !== null) c.commits.push(`${sha} ${clean(subject, s.token).slice(0, 120)}`.trim())
      if (pr) add(c.links, pr)
    })
    return ran
  })

  // The agent wrote its own Hark handoff: don't record the same work twice.
  on('tool.call', { tool: /^mcp__.+__end_session$/ }, async ($, e, next) => {
    const ran = await next(e)
    const handedOff = typeof (e as unknown as Record<string, unknown>).what_i_did === 'string' && ran.deny === undefined && ran.isError !== true
    if (e.agentId !== undefined || !handedOff || !(await s.ready)) return ran
    await save($, s, c => Object.assign(c, { closed: true, handoff: 'Clean' }))
    show($, s)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const isSummary = e.agentId === undefined && e.reason === 'answer' && !e.isAborted && e.answer.trim() !== ''
    if (isSummary && (await s.ready)) await record($, s, c => { c.notes = clean(e.answer, s.token) })
    return next(e)
  })

  // A conversation moved to a background process leaves a continued-in row as the last thing in its old transcript.
  // When the transcript can't be read, the shared state says whether a later process took the conversation.
  on('classic.SessionEnd', async ($, e, next) => {
    if (!(await s.ready)) return next(e)
    const moved = await movedAway($, e.transcript_path)
    if (moved === null) await save($, s)
    s.moved = moved ?? (s.c.latest !== '' && s.c.latest !== s.session)
    return next(e)
  })

  // 4. Hand off when the session ends (exit, /clear, resume, logout, signal), unless the conversation moved on:
  // the process carrying it now hands off instead, with this one's work from the shared store.
  on('session.end', async ($, e, next) => {
    if ((await s.ready) && !(s.moved && s.shared)) await handoff($, s, () => next.budget.remainingMs)
    if (e.reason === 'clear' || e.reason === 'resume') s = fresh() // a new conversation: its own key, state and brief
    return next(e)
  })

  // 5. /hark brief | handoff | needs | open
  on('command.run', { command: 'hark' }, async ($, e) => {
    s.ready ??= boot($, s, accessKey)
    return { text: await command($, s, e.args.trim().split(/\s+/)[0] || 'brief') }
  })
}

async function boot($: EngineInterface, s: Hark, accessKey: string): Promise<boolean> {
  try {
    // .hark/project (or a .hark file) in the session's directory or the nearest one above it
    for (let dir = await $.session.root(); !s.code && dir; dir = dir.replace(/[\\/][^\\/]*$/, '')) {
      for (const file of ['.hark/project', '.hark']) s.code ||= CODE.exec(await $.fs.read(`${dir}/${file}`).catch(() => ''))?.[1] ?? ''
      s.root = dir
    }
    if (!s.code) return false
    s.token = accessKey
    if (!s.token) return note($, s, `no access key; set it with ${CONFIGURE}`), false
    // Requests name the mod and the engine: User-Agent hark-mod/<plugin.json version> (claude-code/<runtime version>)
    const manifest = o(parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => ''), null))
    const runtime = await $.session.version().then(v => v.version, () => 'unknown')
    s.agent = `hark-mod/${manifest.version ?? 'unknown'} (claude-code/${runtime})`
    // The conversation key is the same in every process that carries this conversation: a hash of the session root and the
    // conversation's first launch, which a background move and --resume keep and /clear starts over.
    s.session = await $.session.id().catch(() => '')
    const started = await $.session.usage().then(u => `${s.root}#${u.startedAt}`, () => s.session)
    s.key = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(started))).slice(0, 16))
    const now = await $.clock.now()
    s.record = `c:${s.key}:${now.toString(36)}:${hex(crypto.getRandomValues(new Uint8Array(4)))}`
    await save($, s) // what other processes of this conversation left
    const cached = o(await $.store.get(`brief:${s.code}`).catch(() => null))
    // another process of this conversation fetched a brief and saved lately, and the project's cache is at least that new
    const recent = cached.brief != null && s.c.briefAt > 0 && Number(cached.at) >= s.c.briefAt && now - s.c.updatedAt < STATE_FRESH_MS
    await save($, s, c => {
      c.id ||= hex(crypto.getRandomValues(new Uint8Array(16)))
      c.latest = s.session
      if (s.session) add(c.sessions, s.session)
    })
    await prune($, s, now)
    if (recent) show($, s)
    s.brief = recent ? Promise.resolve(cached.brief) : brief($, s) // reuse the brief another process of this conversation fetched
    return true
  } catch (err) { return note($, s, `setup failed (${errText(err)})`), false }
}

// MCP over HTTP, stateless: each call is one JSON-RPC tools/call POST, as Hark's own hooks send it.
async function call($: EngineInterface, s: Hark, tool: string, args: Record<string, unknown>, ms = 3000): Promise<unknown> {
  const id = ++s.rpc, wait = Math.max(100, ms)
  const late = $.clock.sleep(wait).then(() => Promise.reject(new Error(`no reply in ${wait}ms`)), () => new Promise<never>(() => {}))
  const res = await Promise.race([
    $.http.fetch('https://harkstudio.io/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.token}`,
        'user-agent': s.agent, 'x-hark-client': CLIENT,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args, _meta: { client: CLIENT, conversation: s.c.id } } }),
    }),
    late,
  ])
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // The reply is one JSON-RPC message, or an SSE stream whose data lines carry it.
  const frames = res.headers['content-type']?.includes('event-stream')
    ? res.text.split(/\r?\n\r?\n/).map(f => f.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'))
    : [res.text]
  const msg = frames.map(f => o(parse(f, null))).find(m => m.id === id) ?? {}
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
  const h = o(o(b).handoff), pending = o(b).open_candidates, now = await $.clock.now()
  const state = h.draft ? 'Draft' : /clean|closed|ended|confirmed/i.test(String(h.status ?? '')) ? 'Clean' : 'Open'
  const needs = typeof pending === 'number' ? pending : a(o(o(b).unreviewed).items).length
  await $.store.set(`brief:${s.code}`, { at: now, brief: b }).catch(() => undefined) // one cached brief per project, not per conversation
  await save($, s, c => Object.assign(c, { briefAt: now, opened: true, handoff: state, needs }))
  show($, s)
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
  const hits = (await (s.rules ??= rules($, s))).filter(r => !s.c.allowed.includes(r.id) && matches(r, rel))
  if (!hits.length) return null
  const count = (t: string) => (t ? t.split('\n').length : 0)
  const summary = `${tool} ${rel} (-${count(removed)} +${count(added)} lines)`
  const reasons = hits.map(h => `${h.title} covers this edit.\nWhy: ${h.why}`).join('\n\n')
  const answer = await $.ui.ask(`${reasons}\n\n${summary}\n\nAllow it?`, { header: 'Hark', options: ['Allow', 'Stop'] }).then(t => t.trim(), () => '')
  if (answer === '') return note($, s, `could not ask about ${hits.map(h => h.title).join(', ')}; the edit went ahead`), null
  if (answer === 'Allow') return await save($, s, c => hits.forEach(h => add(c.allowed, h.id))), null
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

// A settled record's scope, as path globs and areas. Hark's structured fields win; without them, the text convention:
// a "(scope: src/db/**, billing)" title marker or a "scope: ..." body line.
function asRule(kind: string, v: unknown): Rule[] {
  const x = o(v), name = typeof v === 'string' ? v : x.title, scope = o(x.scope)
  const isPath = (p: string) => /[/*?.]/.test(p)
  const loose = scopeWords(Array.isArray(x.scope) || typeof x.scope === 'string' ? x.scope : null, x.scopes, x.applies_to)
  let paths = [...scopeWords(scope.paths, x.scope_paths, x.paths, x.files), ...loose.filter(isPath)]
  let areas = [...scopeWords(x.scope_area, scope.areas, scope.area, x.areas, x.area), ...loose.filter(p => !isPath(p))]
  if (!paths.length && !areas.length) {
    const line = /^\s*(?:scope|areas?|paths?|files?)\s*:\s*(.+)$/im.exec(`${x.body ?? ''}\n${x.rationale ?? ''}`)?.[1]
    const titled = /\b(?:scope|areas?|paths?|files?)\s*:\s*([^)\]\n]+)/i.exec(String(name ?? ''))?.[1]
    const marked = scopeWords(...[titled, line].flatMap(m => m?.split(/[,\s]+/) ?? []))
    paths = marked.filter(isPath)
    areas = marked.filter(p => !isPath(p))
  }
  const unsettled = /propos|candidate|reject|supersed|draft|pending|retir|expir|obsolete/i.test(`${x.status ?? ''} ${x.acceptance ?? ''} ${x.applicability ?? ''}`)
  if ((!paths.length && !areas.length) || unsettled || x.superseded_by || x.accepted === false) return []
  const title = String(name ?? x.summary ?? 'Untitled').replace(/\s*[([]?\b(?:scope|areas?|paths?|files?)\s*:.*$/i, '')
  const why = String(x.why ?? x.rationale ?? x.body ?? '').replace(/^\s*(?:scope|areas?|paths?|files?)\s*:.*$/gim, '').trim().slice(0, 300)
  return [{ id: String(x.id ?? `${kind}:${title}`), title: `${kind} "${title}"`, why: why || 'No rationale recorded.', paths, areas }]
}

// The scope strings among some fields' values, without filler words a marker may hold ("billing and booking").
function scopeWords(...values: unknown[]): string[] {
  return values.flatMap(a).filter((p): p is string => typeof p === 'string').map(p => p.trim())
    .filter(p => p.length > 2 && !/^(?:and|the|for|all|any|not)$/i.test(p))
}

// Explicit paths are globs, and a record that has them is matched on them alone. An area (billing, booking) covers the
// files under a directory of that name. The changed text never counts.
function matches(rule: Rule, path: string): boolean {
  if (rule.paths.length) {
    return rule.paths.some(p => {
      const glob = p.replace(/^\.?\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')
      return new RegExp(`(^|/)${glob}($|/)`).test(path)
    })
  }
  const dirs = path.toLowerCase().split('/').slice(0, -1)
  return rule.areas.some(area => dirs.includes(area.toLowerCase()))
}

// end_session for the conversation's work since the last handoff, sent once, by whichever process ends it first;
// session_stopped when Hark answers it with an error and time remains. A timeout is not retried.
async function handoff($: EngineInterface, s: Hark, left: () => number): Promise<string> {
  const ms = () => left() - 400 // leave the rest of the exit window to the hooks after this one
  await save($, s) // pick up what other processes of this conversation recorded
  if (s.c.closed || !busy(s.c)) {
    const reason = 'Claude Code session with no edits, commits or test runs'
    if (s.c.opened) await attempt($, s, 'close_session failed', 'close_session', { reason }, ms())
    await save($, s, c => { c.opened = false })
    return s.c.closed ? 'Already handed off; nothing new since.' : 'Nothing to hand off: no edits, commits or test runs in this session.'
  }
  if (!(await claim($, s))) return 'Another Claude Code process is handing this conversation off.'
  // Close the segment before sending: work recorded while end_session is in flight opens the next one.
  const segment = s.c.segment
  await soon($, save($, s, c => { if (c.segment === segment) c.closed = true }))
  const work = { ...s.c }
  const ended = await attempt($, s, 'end_session failed', 'end_session', handoffArgs(s, work), ms())
  let result = `Handoff saved to Hark (${s.code}).`, state: Conversation['handoff'] = 'Clean'
  if (ended instanceof Error) {
    const late = ended.message.startsWith('no reply') || ms() < 100
    const stopped = late ? ended : await attempt($, s, 'session_stopped failed', 'session_stopped', { venture: s.code }, ms())
    state = stopped instanceof Error ? work.handoff : 'Draft'
    result = late ? `Hark did not take the handoff (${ended.message}).`
      : stopped instanceof Error ? `Hark is unreachable; no handoff was recorded (${stopped.message}).`
      : 'Hark could not take the handoff, so it will draft one from repo activity.'
  }
  await soon($, save($, s, c => Object.assign(c, { opened: false, handoff: state }))) // attempted once; Hark's idle sweep covers a miss
  show($, s)
  return result
}

// When two processes end the same conversation at once, only one hands its segment off: each stores a claim, and the first
// claim the store holds wins, since $.store keeps keys in the order they were first set. A claim older than LOCK_STALE_MS was
// left by a process that died mid-handoff and no longer counts. When the store refuses the claim, the closed flag decides.
async function claim($: EngineInterface, s: Hark): Promise<boolean> {
  const now = await $.clock.now(), prefix = `handoff:${s.key}:${s.c.segment}:`
  const mine = `${prefix}${now.toString(36)}:${crypto.randomUUID()}`
  await soon($, $.store.set(mine, true)) // a claim still waiting on the store's lock counts as refused
  for (const k of (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith(prefix))) {
    if (k === mine) return true
    if (now - parseInt(k.split(':')[3] ?? '', 36) < LOCK_STALE_MS) return false // an earlier, live claim
  }
  return true
}

// Keeps the store small (Claude Code caps it at 4 MiB). Drops records not saved for KEEP_MS, and, once this process has
// stored its merged record, this conversation's other records idle for STATE_FRESH_MS (a live process stores its state again
// on its next save); cached briefs older than KEEP_MS; and claims older than an hour. A key's age is in its name, and a key
// that looks old is read for when it was last saved. At most 20 deletions per start: a long-unused store clears over several.
async function prune($: EngineInterface, s: Hark, now: number): Promise<void> {
  let left = 20
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    const [kind, conv, third, fourth] = k.split(':')
    const limit = kind === 'handoff' ? 60 * 60_000 : kind === 'c' && conv === s.key && s.shared ? STATE_FRESH_MS : KEEP_MS
    let at = kind === 'c' ? parseInt(third ?? '', 36) : kind === 'handoff' ? parseInt(fourth ?? '', 36) : kind === 'brief' ? 0 : NaN
    if (left === 0 || k === s.record || !(now - at > limit)) continue
    if (kind !== 'handoff') at = Math.max(at, Number(o(await $.store.get(k).catch(() => null))[kind === 'c' ? 'updatedAt' : 'at']) || 0)
    if (now - at > limit) left -= await $.store.delete(k).then(() => 1, () => 0)
  }
}

// Waits for a store write at most EXIT_WRITE_MS, so a held store lock can't use up the exit window; the write goes on.
async function soon($: EngineInterface, write: Promise<unknown>): Promise<boolean> {
  return Promise.race([write.then(() => true, () => false), $.clock.sleep(EXIT_WRITE_MS).then(() => false, () => false)])
}

// The conversation moved on when its transcript's last continued-in row has no reply from Claude after it.
// null when the transcript can't be read (the host reads files up to 4 MiB).
async function movedAway($: EngineInterface, transcript: string): Promise<boolean | null> {
  if (!transcript) return null
  const end = (await $.fs.read(transcript).catch(() => null))?.slice(-65536)
  if (end == null) return null
  const types = end.split('\n').map(line => String(o(parse(line, null)).type ?? ''))
  const at = types.lastIndexOf('continued-in')
  return at >= 0 && !types.slice(at + 1).includes('assistant')
}

// One save at a time in each process: two at once would merge from the same copy, and the later would drop the other's change.
function save($: EngineInterface, s: Hark, change?: (c: Conversation) => void): Promise<void> {
  const run = s.saving.then(() => saveNow($, s, change))
  s.saving = run.catch(() => undefined)
  return run
}

// Merges the records every process of this conversation stored, then stores this process's own. Processes never write the
// same key, so no write overwrites another's. The oldest record, this process's own included, is merged last, so the first
// record's conversation id wins in every process.
async function saveNow($: EngineInterface, s: Hark, change?: (c: Conversation) => void): Promise<void> {
  const records = (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith(`c:${s.key}:`))
  for (const k of records.reverse()) s.c = merge(s.c, sane(await $.store.get(k).catch(() => null)))
  if (!change) return
  change(s.c)
  s.c.updatedAt = await $.clock.now()
  try {
    await $.store.set(s.record, s.c)
    s.shared = true
  } catch (err) {
    s.shared = false
    note($, s, `state not saved (${errText(err)})`)
  }
}

// A stored record is data from disk: keep only fields of the expected type.
function sane(v: unknown): Conversation {
  const x = o(v), out: Record<string, unknown> = conversation()
  for (const [k, fallback] of Object.entries(out)) {
    if (Array.isArray(fallback)) out[k] = a(x[k]).filter(t => typeof t === 'string')
    else if (typeof x[k] === typeof fallback) out[k] = x[k]
  }
  return out as Conversation
}

// New activity after a handoff starts the conversation's next segment. The process doing the work carries the conversation.
async function record($: EngineInterface, s: Hark, change: (c: Conversation) => void): Promise<void> {
  await save($, s, c => {
    if (c.closed) Object.assign(c, { segment: c.segment + 1, closed: false, notes: '', files: [], commits: [], tests: [], links: [] })
    c.latest = s.session
    change(c)
  })
}

function merge(mine: Conversation, disk: Conversation): Conversation {
  if (disk.segment < mine.segment) return mine
  const same = disk.segment === mine.segment
  const out: Conversation = { ...(same && mine.updatedAt >= disk.updatedAt ? mine : disk), closed: disk.closed || (same && mine.closed) }
  out.id = disk.id || mine.id // the first process to save names the conversation
  for (const k of LISTS) if (same || k === 'allowed' || k === 'sessions') out[k] = [...new Set([...mine[k], ...disk[k]])]
  return out
}

function handoffArgs(s: Hark, act: Conversation) {
  const notes = clean(act.notes, s.token)
  const lines = notes.split('\n'), at = lines.findIndex(l => NEXT.test(l))
  const nextUp = at < 0 ? '' : lines.slice(at, at + 6).join('\n').replace(NEXT, '').trim().split(/\n\s*\n/)[0] ?? ''
  const tests = act.tests.map(t => t.slice(t.indexOf(' ') + 1)) // each run is tagged so that repeats aren't merged away
  const failing = tests.filter(t => t.endsWith('failed')).join('; ')
  const files = act.files
  const counts = `Claude Code session: ${files.length} file(s) edited, ${act.commits.length} commit(s), ${tests.length} test run(s).`
  const review = `Review this session's changes${files.length ? ` to ${files.slice(0, 3).join(', ')}` : ''}.`
  return {
    venture: s.code,
    what_i_did: [counts, ...tests.map(t => `Tests ${t}`), notes && `Agent notes:\n${notes}`].filter(Boolean).join('\n'),
    what_changed: [...files.map(f => `edited ${f}`), ...act.commits.map(c => `commit ${c}`)].slice(0, 60).join('\n') || 'No file edits or commits recorded.',
    whats_next: nextUp.trim() || (failing ? `Fix the failing test runs: ${failing}` : review),
    links: [...act.links, ...files].slice(0, 10),
    ...(failing ? { watch_out_for: `Failing test runs: ${failing}` } : {}),
  }
}

async function command($: EngineInterface, s: Hark, sub: string): Promise<string> {
  if (!(await s.ready)) return `Hark is not set up here: run \`hark init\` in the project, then set the access key with ${CONFIGURE}.`
  if (sub === 'handoff') return handoff($, s, () => 3400)
  if (sub === 'brief') {
    const b = (await brief($, s)) ?? (await s.brief)
    return b == null ? 'Hark is unreachable right now.' : `**Hark ${s.code}** · ${s.c.handoff} · ${s.c.needs} need you\n\n${render(b, false)}`
  }
  if (sub === 'needs') {
    const r = await attempt($, s, 'needs unavailable', 'list_candidates', { venture: s.code })
    if (r instanceof Error) return 'Hark is unreachable right now.'
    const proposals = a(o(r).entries).map(v => `- ${o(v).kind ?? 'proposal'}: ${words(v)}`)
    const items = [...proposals, ...a(o(r).build_state_fields).map(v => `- proposed ${o(v).field ?? words(v)}`)]
    await save($, s, c => { c.needs = items.length })
    show($, s)
    return items.length ? `**${items.length} need you** (review at https://harkstudio.io)\n${items.join('\n')}` : 'Nothing needs you.'
  }
  if (sub !== 'open') return 'Usage: /hark brief | handoff | needs | open'
  const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
  if (!s.uuid && isId(s.code)) s.uuid = s.code
  if (!s.uuid) {
    const v = await attempt($, s, 'project link unavailable', 'get_venture', { id_or_code: s.code })
    if (!(v instanceof Error)) s.uuid = [o(v).id, o(o(v).venture).id].find(isId) ?? ''
  }
  // A link to click: hark starts no program, browser included.
  return `${s.code} on Hark: ${s.uuid ? `https://harkstudio.io/ventures/${s.uuid}` : 'https://harkstudio.io/studio'}`
}

// The agent view's empty "new session" placeholder: a spare process nobody has given a prompt yet. Counting the
// prompts keeps a placeholder that got a task, then reloaded (a changed access key), from going quiet.
async function placeholder($: EngineInterface): Promise<boolean> {
  return (await $.env.get('CLAUDE_BG_SOURCE')) === 'spare' && (await $.session.turns().catch(() => 0)) === 0
}

function show($: EngineInterface, s: Hark) {
  $.ui.status(`Hark ${s.code} · ${s.c.handoff} · ${s.c.needs} need you`)
}

function note($: EngineInterface, s: Hark, text: string) {
  if (!s.logged.has(text)) $.ui.log(`hark: ${text}`)
  s.logged.add(text)
}
