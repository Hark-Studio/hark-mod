import { describe, expect, mock, test } from 'claude-code/testing'

import { BRIEF, COMMAND, EDIT, END, ENDPOINT, MANIFEST, MESSAGES, RUNTIME, SESSION, STARTED, TURN, UUID, healthy, keyOf, rpc, world } from './world'

type Blocks = { blocks: readonly { name: string; text: string }[] }
const COMMIT = '[main abc1234def] Add the guard\n 1 file changed'
const bash = (cmd: string) => cmd.startsWith('git commit')
  ? { result: { stdout: `[INFO] token=abc\n${COMMIT}`, stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abc1234def', kind: 'committed' } } } }
  : { result: { stdout: 'tests ok', stderr: '', interrupted: false }, isError: cmd.includes('pytest') }
const block = async ($: { prompt: { context: (e: Blocks) => Promise<Blocks> } }) =>
  (await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-03' }] })).blocks

describe('brief', () => {
  test('rides the first message as a delimited block, with the status line', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    const blocks = await block($)

    expect(blocks[0]).toEqual({ name: 'currentDate', text: '2026-10-03' })
    expect(blocks[1]?.name).toBe('hark')
    expect(blocks[1]?.text).toStartWith('<hark-brief project="V-012">\n')
    expect(blocks[1]?.text).toContain(JSON.stringify(BRIEF))
    expect(blocks[1]?.text).toEndWith('</hark-brief>')
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]).toMatchObject({ url: ENDPOINT, method: 'tools/call', tool: 'get_agent_brief', args: { venture: 'V-012', depth: 'compact' } })
    expect(w.calls[0]?.headers.authorization).toBe('Bearer tok')
    expect(w.statuses).toEqual(['Hark V-012 · Open · 2 need you'])
    expect(w.commands).toEqual(['hark'])
  })

  test('names the mod on every request: User-Agent, X-Hark-Client and params._meta.client', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await block($)
    await $.command.run(COMMAND('handoff')) // nothing done yet: closes the Hark session
    await $.tool.call(EDIT('src/db/users.ts'))
    await $.command.run(COMMAND('needs'))
    await $.command.run(COMMAND('open'))
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'close_session', 'list_journal_entries', 'list_candidates', 'get_venture', 'end_session'])
    const conversation = JSON.parse(w.calls[0]?.body ?? '{}').params._meta.conversation
    expect(conversation).toMatch(/^[0-9a-f]{32}$/)
    expect(conversation).not.toBe(await keyOf()) // random, not the guessable hash of the path and launch time
    for (const c of w.calls) {
      expect(c.url, c.tool).toBe(ENDPOINT)
      expect(c.headers.authorization, c.tool).toBe('Bearer tok')
      expect(c.headers['user-agent'], c.tool).toBe(`hark-mod/${MANIFEST.version} (claude-code/${RUNTIME})`)
      expect(c.headers['x-hark-client'], c.tool).toBe('claude-code-mod')
      expect(JSON.parse(c.body).params._meta, c.tool).toEqual({ client: 'claude-code-mod', conversation })
    }
    expect(w.reads.filter(p => p.endsWith('/.claude-plugin/plugin.json'))).toHaveLength(1)
    expect([w.runs, w.writes]).toEqual([[], []]) // no program started, no file written
    expect(new Set(w.env)).toEqual(new Set(['CLAUDE_BG_SOURCE']))
  })

  test('without an access key it stays idle: no request, program, write, stored state or question, and one log line', async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, bash })

    const first = await $.command.run(COMMAND('brief')) // /hark before session.start
    await $.session.start(SESSION)
    await block($)
    await $.tool.call(EDIT('src/db/users.ts'))
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
    await $.turn.complete(TURN('Done.'))
    await $.command.run(COMMAND('open'))
    await $.session.end(END())

    expect(first.text).toBe('Hark is not set up here: run `hark init` in the project, then set the access key with /plugin configure hark-memory@hark (hark-memory@synced if you added it from the Claude directory).')
    expect([w.calls, w.runs, w.writes, w.asks, w.statuses, [...w.store.keys()]]).toEqual([[], [], [], [], [], []])
    expect(w.logs).toEqual(['hark: no access key; set it with /plugin configure hark-memory@hark (hark-memory@synced if you added it from the Claude directory)'])
    expect(new Set(w.env)).toEqual(new Set(['CLAUDE_BG_SOURCE'])) // the only variable hark reads
  })

  test('trims the access key, and /hark works before session.start', { options: { access_key: '  tok \n' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    const { text } = await $.command.run(COMMAND('brief'))

    expect(text).toStartWith('**Hark V-012** · Open · 2 need you')
    expect(w.calls.map(c => c.headers.authorization)).toEqual(['Bearer tok', 'Bearer tok']) // the boot's brief, then /hark brief
  })

  test("accepts a .hark file (venture=V-###), as Hark's own installer writes it", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { files: { '/work/.hark': 'venture=V-034\n' }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.calls[0]?.args.venture).toBe('V-034')
    expect(w.calls[0]?.headers.authorization).toBe('Bearer tok')
  })

  test('the nearest project file wins', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { cwd: '/work/app', files: { '/work/app/.hark/project': 'V-001', '/work/.hark': 'venture=V-034' }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.calls[0]?.args.venture).toBe('V-001')
  })

  test('finds .hark/project in a parent folder and works relative to it', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { cwd: '/work/packages/app', hark: healthy })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(w.calls[0]?.args.venture).toBe('V-012')
    expect(w.asks[0]?.question).toContain('Edit src/db/users.ts')
  })

  test('does nothing outside a Hark project', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { project: null, hark: healthy })

    await $.session.start(SESSION)
    const blocks = await block($)
    const reply = await $.command.run(COMMAND('brief'))
    await $.session.end(END())

    expect(blocks).toHaveLength(1)
    expect(w.calls).toEqual([])
    expect(w.statuses).toEqual([])
    expect(reply.text).toContain('hark init')
  })

  test('fails open with one log line when Hark is down', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: () => ({ status: 503, text: 'down' }) })

    await $.session.start(SESSION)
    const blocks = await block($)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    await block($)

    expect(blocks).toHaveLength(1)
    expect(w.tools()).toEqual(['get_agent_brief', 'get_agent_brief'])
    expect(w.logs).toEqual(['hark: brief unavailable (HTTP 503)'])
    expect(w.statuses).toEqual(['Hark V-012 · offline', 'Hark V-012 · offline'])
  })

  test('a hung server is cut off after 3 s', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { hark: async () => (await clock.sleep(60_000), healthy('get_agent_brief')) })

    await $.session.start(SESSION)
    const pending = block($)
    await clock.advance(3_000)

    expect(await pending).toHaveLength(1)
    expect(w.logs).toEqual(['hark: brief unavailable (no reply in 3000ms)'])
  })

  test('reads a streamed (SSE) reply', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const sse = `id: 0\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${rpc(1, BRIEF)}\n\n`
    world(on, { hark: () => ({ text: sse, headers: { 'content-type': 'text/event-stream' } }) })

    await $.session.start(SESSION)

    expect((await block($))[1]?.text).toContain('"identity"')
  })

  test('shows Draft when an earlier session left a draft handoff', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: () => ({ result: { ...BRIEF, handoff: { ...BRIEF.handoff, draft: { session_id: 'x' } } } }) })

    await $.session.start(SESSION)
    await block($)

    expect(w.statuses).toEqual(['Hark V-012 · Draft · 2 need you'])
  })
})

describe('compaction', () => {
  test('re-injects the sub-brief: decisions, non-goals, blockers, next action', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    const recap = (await block($))[1]?.text ?? ''

    expect(w.tools()).toEqual(['get_agent_brief', 'get_agent_brief'])
    expect(w.invalidated).toEqual(['prompt.context'])
    expect(recap).toStartWith('<hark-recap project="V-012">')
    expect(recap).toContain('Accepted decisions:\n- Use Uniswap deep links — Stays non-custodial')
    expect(recap).toContain('Non-goals:\n- No custodial wallets (scope: src/wallet/**)\n- No mobile app')
    expect(recap).toContain('Blockers:\n- Rialto API key pending')
    expect(recap).toContain('Next action:\n- Wire Rialto swaps')
    expect(recap).not.toContain('Polish receipts')
  })

  test('keeps the first brief when the refresh fails; ignores precompute, subagents and skipped compactions', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    let up = true
    on('session.compact', { trigger: 'plugin' }, () => ({ skip: 'not now' }))
    const w = world(on, { hark: tool => (up ? healthy(tool) : undefined) })

    await $.session.start(SESSION)
    await block($)
    await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: MESSAGES })
    expect(w.tools()).toEqual(['get_agent_brief'])
    await $.session.compact({ trigger: 'plugin', messages: MESSAGES })
    expect((await block($))[1]?.text).toStartWith('<hark-brief')

    up = false
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    expect((await block($))[1]?.text).toContain('- Wire Rialto swaps')
  })
})

describe('edit guard', () => {
  test('asks once per decision, with its title and why; Allow is remembered', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    const first = await $.tool.call(EDIT('src/db/users.ts'))
    const again = await $.tool.call(EDIT('src/db/orders.ts'))

    expect(first.deny).toBeUndefined()
    expect(again.deny).toBeUndefined()
    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]).toMatchObject({ header: 'Hark', options: ['Allow', 'Stop'] })
    expect(w.asks[0]?.question).toBe('Decision "Raw SQL, no ORM" covers this edit.\nWhy: Queries stay reviewable\n\nEdit src/db/users.ts (-1 +1 lines)\n\nAllow it?')
    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries'])
  })

  test('Stop refuses the edit with the decision, and asks again next time', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Stop' })

    await $.session.start(SESSION)
    const r = await $.tool.call(EDIT('src/db/users.ts'))
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(r.deny).toBe('Stopped by the user: Edit src/db/users.ts (-1 +1 lines) conflicts with Hark Decision "Raw SQL, no ORM" (Queries stay reviewable). Do not retry it; ask the user how to proceed.')
    expect(w.asks).toHaveLength(2)
  })

  test('reads scope from titles, body lines and non-goals; skips unscoped or unaccepted records', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/app.ts'))
    await $.tool.call(EDIT('lib/pay.ts', 'charge(billing)'))
    await $.tool.call(EDIT('src/billing/pay.ts'))
    await $.tool.call({ tool: 'Write', file_path: '/work/src/wallet/keys.ts', content: 'k' })

    expect(w.asks.map(a => a.question.split('\n')[0])).toEqual([
      'Decision "Stripe is the only processor" covers this edit.',
      'Non-goal "No custodial wallets" covers this edit.',
    ])
    expect(w.asks[0]?.question).toContain('Why: One reconciliation path.\n\n')
  })

  test("prefers Hark's structured scope field over a marker in the text", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('deploy/app.yaml'))
    await $.tool.call(EDIT('infra/main.tf'))

    expect(w.asks.map(a => a.question.split('\n')[0])).toEqual(['Decision "Infra via Terraform" covers this edit.'])
  })

  test('one question lists every matching record; Allow covers them all', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/db/billing/charges.ts'))
    await $.tool.call(EDIT('src/db/x.ts', 'billing'))

    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]?.question).toContain('Decision "Raw SQL, no ORM" covers this edit.')
    expect(w.asks[0]?.question).toContain('Decision "Stripe is the only processor" covers this edit.')
  })

  test('an area covers files under a directory of that name, never the changed text (the "booking" false positive)', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Stop' }) // Stop, so every matching edit asks again
    const first = (q: { question: string }) => q.question.split('\n\n').filter(l => l.includes('covers this edit')).map(l => l.split(' covers')[0])

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/billing/deposit.ts', old_string: 'when a surf lesson is booked', new_string: 'at booking' })
    await $.tool.call(EDIT('lib/booking.ts')) // a file named after the area is not under its directory
    await $.tool.call(EDIT('docs/notes.md', 'booking and billing'))
    await $.tool.call(EDIT('src/Booking/slots.ts'))

    expect(w.asks.map(first)).toEqual([['Decision "Stripe is the only processor"'], ['Decision "Add a waitlist when a lesson is full"']])
  })

  test("Hark's scope.paths decide alone: areas then map to those paths", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const entries = [
      { id: 'p1', title: 'Payments live in one place', rationale: 'One audit trail', acceptance: 'accepted', scope: { areas: ['billing'], paths: ['payments/**'] } },
      { id: 'p2', title: 'Infra is Terraform only', rationale: 'Reviewable', acceptance: 'accepted', scope_area: ['ops'], scope_paths: ['infra/*.tf'] },
    ]
    const w = world(on, { hark: tool => (tool === 'list_journal_entries' ? { result: { entries } } : healthy(tool)), answer: () => 'Stop' })

    await $.session.start(SESSION)
    for (const file of ['src/billing/a.ts', 'payments/a.ts', 'ops/run.sh', 'infra/main.tf', 'infra/vars.json']) await $.tool.call(EDIT(file))

    expect(w.asks.map(a => a.question.split('\n\n').at(-2))).toEqual(['Edit payments/a.ts (-1 +1 lines)', 'Edit infra/main.tf (-1 +1 lines)'])
  })

  test('a dismissed question lets the edit through and says so', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => null })

    await $.session.start(SESSION)
    const r = await $.tool.call(EDIT('src/db/users.ts'))

    expect(r.deny).toBeUndefined()
    expect(w.logs).toEqual(['hark: could not ask about Decision "Raw SQL, no ORM"; the edit went ahead'])
  })

  test('parallel edits each ask for themselves', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Stop' })

    await $.session.start(SESSION)
    const [a, b] = await Promise.all([$.tool.call(EDIT('src/db/a.ts')), $.tool.call(EDIT('src/db/b.ts'))])

    expect(w.asks).toHaveLength(2)
    expect(a.deny).toContain('Stopped by the user')
    expect(b.deny).toContain('Stopped by the user')
  })

  test('NotebookEdit is guarded; edits outside the project are neither guarded nor recorded', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/billing/pay.ipynb', new_source: 'charges\nmore' })
    await $.tool.call({ tool: 'Edit', file_path: '/Users/me/other/src/db/x.ts', old_string: 'a', new_string: 'b' })
    await $.session.end(END())

    expect(w.asks.map(a => a.question.split('\n\n')[1])).toEqual(['NotebookEdit billing/pay.ipynb (-0 +2 lines)'])
    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_changed).toBe('edited billing/pay.ipynb')
    expect(w.sent()).not.toContain('/Users/me')
  })

  test('decisions that fail to load are retried a minute later, not on every edit', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on)
    let up = false
    const w = world(on, { hark: tool => (tool === 'get_agent_brief' || up ? healthy(tool) : undefined), answer: () => 'Allow' })

    await $.session.start(SESSION)
    expect((await $.tool.call(EDIT('src/db/users.ts'))).deny).toBeUndefined()
    await $.tool.call(EDIT('src/db/users.ts'))
    up = true
    await clock.advance(61_000)
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'list_journal_entries'])
    expect(w.logs).toEqual(['hark: decisions unavailable for the edit check (HTTP 503)'])
    expect(w.asks).toHaveLength(1)
  })
})

describe('handoff', () => {

  test('end_session carries files, commits, tests and agent notes, never contents', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy, bash })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'const key = "do-not-send"' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'CI=1 pytest -q' })
    await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -5' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add the guard"' })
    await $.turn.complete(TURN('Added the guard.\n```ts\nconst k = 1\n```\nToken sk-abcdefghijklmnopqrstuv\n\n## Next steps\n- Ship it'))
    await $.session.end(END())

    const end = w.calls.find(c => c.tool === 'end_session')
    expect(end?.args).toEqual({
      venture: 'V-012',
      what_i_did: 'Claude Code session: 1 file(s) edited, 1 commit(s), 3 test run(s).\nTests npm test: passed\nTests pytest: failed\nTests npm test: result unknown\nAgent notes:\nAdded the guard.\n[code omitted]\nToken [redacted]\n\n## Next steps\n- Ship it',
      what_changed: 'edited src/app.ts\ncommit abc1234 Add the guard',
      whats_next: '- Ship it',
      links: ['src/app.ts'],
      watch_out_for: 'Failing test runs: pytest: failed',
    })
    expect(w.sent()).not.toMatch(/do-not-send|const k = 1|INFO/)
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Clean · 2 need you')
  })

  test('agent notes and commit subjects lose credentials, open or tilde code fences and the access key, on the wire and on disk', { options: { access_key: 'tok-9f8e7d6c5b4a' } }, async ($, on) => {
    mock.clock(on)
    const rotate = { result: { stdout: '[main abc1234] Rotate tok-9f8e7d6c5b4a out\n', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abc1234', kind: 'committed' } } } }
    const w = world(on, { hark: healthy, bash: () => rotate })
    const notes = [
      'Wired Stripe: set STRIPE_SECRET_KEY=sk_live_51Hxyzabcdefghij and DATABASE_URL=postgres://admin:hunter2@db.internal/prod.',
      'The key tok-9f8e7d6c5b4a works.',
      '~~~env\nDB_PASSWORD=hunter2\n~~~',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
      '```env\nSESSION_SECRET=s3cr3t-value',
    ].join('\n')

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/app.ts'))
    await $.tool.call({ tool: 'Bash', command: 'git commit -am "Rotate the key"' })
    await $.turn.complete(TURN(notes))
    expect(JSON.stringify([...w.store])).not.toContain('tok-9f8e')
    await $.turn.complete(TURN('partial ```ts\nconst leaked = 1', { reason: 'aborted', isAborted: true }))
    await $.turn.complete(TURN('subagent notes', { agentId: 'a1' }))
    await $.session.end(END())

    expect(w.sent()).not.toMatch(/sk_live|hunter2|tok-9f8e|b3Blbn|s3cr3t|leaked|subagent notes/)
    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_i_did).toContain('Wired Stripe: set [redacted] and DATABASE_URL=postgres://[redacted]@db.internal/prod.')
    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_changed).toBe('edited src/app.ts\ncommit abc1234 Rotate [redacted] out')
  })

  test('without a Next steps section, whats_next comes from what happened; links stop at 10, PRs first', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const pr = { result: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', action: 'created' } } } }
    const w = world(on, { hark: healthy, bash: () => pr })

    await $.session.start(SESSION)
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Write', file_path: `/work/f${i}.ts`, content: 'x' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
    await $.turn.complete(TURN('Next, I reran everything.'))
    await $.session.end(END())

    const args = w.calls.find(c => c.tool === 'end_session')?.args
    expect(args?.whats_next).toBe("Review this session's changes to f0.ts, f1.ts, f2.ts.")
    expect(args?.links).toEqual(['https://github.com/o/r/pull/7', ...Array.from({ length: 9 }, (_, i) => `f${i}.ts`)])
    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
  })

  test('falls back to session_stopped when Hark refuses end_session', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: tool => (tool === 'end_session' ? { result: 'plan cap reached', isError: true } : healthy(tool)) })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session', 'session_stopped'])
    expect(w.calls.at(-1)?.args).toEqual({ venture: 'V-012' })
    expect(JSON.parse(w.calls.at(-1)?.body ?? '{}').params._meta.client).toBe('claude-code-mod')
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Draft · 2 need you')
    expect(w.logs).toEqual(['hark: end_session failed ("plan cap reached")'])
  })

  test('a timed-out end_session is not followed by session_stopped', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { hark: async tool => (tool === 'end_session' ? (await clock.sleep(60_000), undefined) : healthy(tool)) })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    const end = $.session.end(END())
    await clock.advance(10_000) // the test kit gives session.end a 10 s budget; a real exit has about 1.5 s
    await end

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
    expect(w.logs[0]).toMatch(/^hark: end_session failed \(no reply in 9[56]\d\dms\)$/)
  })

  test('a session without edits, commits or tests closes without a handoff', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.turn.complete(TURN('Here is how the parser works.'))
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'close_session'])
  })

  test('skips its own handoff when the agent already wrote one, but not when that failed', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    let fails = true
    on('tool.call', { tool: 'mcp__hark__end_session' }, () => (fails ? { isError: true, result: 'invalid', text: 'invalid' } : { result: 'ok', text: 'ok' }) as never)
    const w = world(on, { hark: healthy })
    const own = { tool: 'mcp__hark__end_session', venture: 'V-012', what_i_did: 'x', what_changed: 'y', whats_next: 'z' } as never

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.tool.call(own)
    fails = false
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.tool.call(own)
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Clean · 2 need you')
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'close_session'])
  })

  test('/clear and resume hand off, forget Allow answers, and the next conversation gets a full brief', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    let started = STARTED
    const w = world(on, { hark: healthy, answer: () => 'Allow', started: () => started })

    await $.session.start(SESSION)
    await block($)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    await $.tool.call(EDIT('src/db/users.ts'))
    started = STARTED + 1 // Claude Code restarts the conversation's clock at /clear
    await $.session.end(END('clear'))
    const next = (await block($))[1]?.text ?? ''
    await $.tool.call(EDIT('src/db/users.ts'))
    await $.session.end(END('resume'))

    expect(next).toStartWith('<hark-brief')
    expect(w.asks).toHaveLength(2)
    expect(w.tools()).toEqual(['get_agent_brief', 'get_agent_brief', 'list_journal_entries', 'end_session', 'get_agent_brief', 'list_journal_entries', 'end_session'])
  })
})

describe('/hark', () => {
  test('brief prints a readable brief', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    world(on, { hark: healthy })

    await $.session.start(SESSION)
    const { text } = await $.command.run(COMMAND(''))

    expect(text).toStartWith('**Hark V-012** · Open · 2 need you\n\nProject:\nstx ditto (V-012) · stage live\nPhase: beta\nShipping copy trades')
    expect(text).toContain('Next action:\n- Wire Rialto swaps\n- Polish receipts')
  })

  test('needs lists proposals and updates the count', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    const { text } = await $.command.run(COMMAND('needs'))

    expect(text).toBe('**3 need you** (review at https://harkstudio.io)\n- decision: Adopt Rialto\n- proposed blockers\n- proposed summary')
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Open · 3 need you')
  })

  test('open prints the project page as a link, resolved once, and starts no program', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($) // the brief fetched at start, which /hark open doesn't wait for
    const { text } = await $.command.run(COMMAND('open'))
    await $.command.run(COMMAND('open'))

    expect(text).toBe(`V-012 on Hark: https://harkstudio.io/ventures/${UUID}`)
    expect(w.tools().filter(t => t === 'get_venture')).toHaveLength(1)
    expect(w.runs).toEqual([])
  })

  test('open falls back to the studio page when the project id is unknown', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    world(on, { hark: (tool, args) => (tool === 'get_venture' ? undefined : healthy(tool, args)) })

    await $.session.start(SESSION)
    await block($) // the brief fetched at start, which /hark open doesn't wait for
    const { text } = await $.command.run(COMMAND('open'))

    expect(text).toBe('V-012 on Hark: https://harkstudio.io/studio')
  })

  test('open links a project named by its uuid without asking Hark for it', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { project: `${UUID}\n`, hark: healthy })

    await $.session.start(SESSION)
    await block($)
    const { text } = await $.command.run(COMMAND('open'))

    expect(text).toBe(`${UUID} on Hark: https://harkstudio.io/ventures/${UUID}`)
    expect(w.tools()).toEqual(['get_agent_brief'])
  })

  test('open reads the id from a get_venture reply that nests the venture', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    world(on, { hark: (tool, args) => (tool === 'get_venture' ? { result: { venture: { id: UUID, code: 'V-012' } } } : healthy(tool, args)) })

    await $.session.start(SESSION)
    await block($)
    const { text } = await $.command.run(COMMAND('open'))

    expect(text).toBe(`V-012 on Hark: https://harkstudio.io/ventures/${UUID}`)
  })

  test('handoff ends the session now, exit adds nothing; unknown words print usage', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    const handoff = await $.command.run(COMMAND('handoff'))
    await $.session.end(END())
    const usage = await $.command.run(COMMAND('nope'))

    expect(handoff.text).toBe('Handoff saved to Hark (V-012).')
    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Clean · 2 need you')
    expect(usage.text).toBe('Usage: /hark brief | handoff | needs | open')
  })
})

describe('one conversation across processes', () => {
  const NOW = STARTED + 60 * 60_000
  const ID = '0123456789abcdef0123456789abcdef'
  const t36 = (ms: number) => ms.toString(36)
  // What the first process left in the store: its record (an open Hark session, one edit, notes and an Allow) and the project's brief.
  const first = (over: Record<string, unknown> = {}) => ({
    id: ID, latest: 'first-process', segment: 0, closed: false, opened: true, updatedAt: NOW - 60_000, briefAt: NOW - 5 * 60_000, recap: false,
    handoff: 'Open', needs: 2, notes: 'Wired the deposit rate.', files: ['src/a.ts'], commits: [], tests: [], links: [],
    allowed: ['d2'], sessions: ['first-process'], ...over,
  })
  const firstKey = async () => `c:${await keyOf()}:${t36(NOW - 120_000)}:first`
  const seeded = async (over: Record<string, unknown> = {}, brief: unknown = { at: NOW - 5 * 60_000, brief: BRIEF }) =>
    ({ [await firstKey()]: first(over), ...(brief ? { 'brief:V-012': brief } : {}) })
  // This process's own record: the last one stored for the conversation.
  const mine = async (w: { store: Map<string, unknown> }, key?: string) => {
    const k = key ?? (await keyOf())
    return [...w.store].filter(([name]) => name.startsWith(`c:${k}:`)).at(-1)?.[1] as Record<string, unknown> | undefined
  }
  const claims = (w: { store: Map<string, unknown> }) => [...w.store.keys()].filter(k => k.startsWith('handoff:'))

  test('keeps the conversation in the plugin store as work happens: no file written, no program run', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/src/app.ts', content: 'x' })

    const key = await keyOf()
    expect([...w.store.keys()]).toEqual([expect.stringMatching(new RegExp(`^c:${key}:${t36(NOW)}:[0-9a-f]{8}$`)), 'brief:V-012'])
    const state = await mine(w)
    expect(state).toMatchObject({ segment: 0, closed: false, opened: true, updatedAt: NOW, briefAt: NOW, files: ['src/app.ts'], sessions: ['sess-1'], latest: 'sess-1', handoff: 'Open', needs: 2 })
    expect(state?.id).toBe(JSON.parse(w.calls[0]?.body ?? '{}').params._meta.conversation)
    expect(w.store.get('brief:V-012')).toEqual({ at: NOW, brief: BRIEF }) // one cached brief per project
    expect([w.writes, w.runs]).toEqual([[], []])
  })

  test('a second process resumes it: no new brief under 30 minutes, the cached one is injected, earlier work is handed off', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { sessionId: 'background', store: await seeded(), hark: healthy, answer: () => 'Stop' })

    const blocks = await block($) // a background process rebuilds its context before session.start
    await $.session.start(SESSION)
    const allowed = await $.tool.call(EDIT('src/db/users.ts'))
    await $.session.end(END())

    expect(blocks[1]?.text).toContain(JSON.stringify(BRIEF))
    expect(w.statuses[0]).toBe('Hark V-012 · Open · 2 need you')
    expect(allowed.deny).toBeUndefined() // the first process's Allow for d2 still holds
    expect(w.asks).toHaveLength(0)
    expect(w.tools()).toEqual(['list_journal_entries', 'end_session'])
    const end = w.calls.find(c => c.tool === 'end_session')
    expect(end?.args.what_changed).toBe('edited src/a.ts\nedited src/db/users.ts')
    expect(end?.args.what_i_did).toContain('Agent notes:\nWired the deposit rate.')
    expect(JSON.parse(end?.body ?? '{}').params._meta.conversation).toBe(ID) // the same id the first process used
    expect(await mine(w)).toMatchObject({ id: ID, closed: true, opened: false, latest: 'background', sessions: ['first-process', 'background'] })
    expect(w.store.get(await firstKey())).toEqual(first()) // each process writes only its own record
  })

  for (const [minutes, tools] of [[29, []], [31, ['get_agent_brief']]] as const) {
    test(`state saved ${minutes} minutes ago ${minutes < 30 ? 'reuses the cached brief' : 'fetches a new brief, however recent the cache'}`, { options: { access_key: 'tok' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      const w = world(on, { store: await seeded({ updatedAt: NOW - minutes * 60_000, briefAt: NOW - minutes * 60_000 }, { at: NOW - minutes * 60_000, brief: BRIEF }), hark: healthy })

      await $.session.start(SESSION)
      await block($)

      expect(w.tools()).toEqual([...tools])
    })
  }

  test('a busy conversation reuses its brief, however old the brief, while the state is fresh', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded({ briefAt: NOW - 3 * 60 * 60_000 }, { at: NOW - 3 * 60 * 60_000, brief: BRIEF }), hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.calls).toEqual([])
  })

  test('without a cached brief for the project, a fresh state still fetches one', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded({}, null), hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.tools()).toEqual(['get_agent_brief'])
  })

  test("a cached brief isn't reused when this conversation never fetched one, or fetched a newer one", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const DAY = 24 * 60 * 60_000
    const never = world(on, { store: await seeded({ opened: false, briefAt: 0 }, { at: NOW - 13 * DAY, brief: BRIEF }), hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(never.tools()).toEqual(['get_agent_brief'])
  })

  test('a cached brief older than the conversation\'s own last fetch is not reused', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded({ briefAt: NOW - 5 * 60_000 }, { at: NOW - 10 * 60_000, brief: BRIEF }), hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.tools()).toEqual(['get_agent_brief'])
  })

  test('a later process of the conversation reuses the brief this one fetched, from the record this one left', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await clock.advance(10 * 60_000)
    await $.session.end(END('resume')) // the same conversation key: the next boot has only the store to go on
    const next = await block($)

    expect(next[1]?.text).toContain(JSON.stringify(BRIEF))
    expect(w.tools()).toEqual(['get_agent_brief', 'close_session'])
  })

  test('once another process handed off, this one sends nothing for the same work', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded({ closed: true, opened: false, handoff: 'Clean' }), hark: healthy })

    await $.session.start(SESSION)
    const reply = await $.command.run(COMMAND('handoff'))
    await $.session.end(END())

    expect(reply.text).toBe('Already handed off; nothing new since.')
    expect(w.calls).toEqual([])
  })

  test('only the process whose claim the store holds first hands a segment off', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const key = await keyOf()
    const w = world(on, {
      store: await seeded(),
      hark: healthy,
      // another process ending the same conversation stores its claim a moment before this one's lands
      onSet: (k, store) => { if (k.startsWith('handoff:')) store.set(`handoff:${key}:0:${t36(NOW)}:other`, true) },
    })

    await $.session.start(SESSION)
    const reply = await $.command.run(COMMAND('handoff'))

    expect(reply.text).toBe('Another Claude Code process is handing this conversation off.')
    expect(w.calls).toEqual([])
    expect(claims(w)).toEqual([`handoff:${key}:0:${t36(NOW)}:other`, expect.stringMatching(new RegExp(`^handoff:${key}:0:${t36(NOW)}:[0-9a-f-]{36}$`))])
  })

  for (const [age, reply] of [[29_000, 'Another Claude Code process is handing this conversation off.'], [31_000, 'Handoff saved to Hark (V-012).']] as const) {
    test(`a claim ${age / 1000} s old ${age < 30_000 ? 'still holds' : 'was left by a process that died mid-handoff, and expires'}`, { options: { access_key: 'tok' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      world(on, { store: { ...(await seeded()), [`handoff:${await keyOf()}:0:${t36(NOW - age)}:dead`]: true }, hark: healthy })

      await $.session.start(SESSION)

      expect((await $.command.run(COMMAND('handoff'))).text).toBe(reply)
    })
  }

  test('when the store refuses the claim, the closed flag decides; a live earlier claim still wins', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const key = await keyOf()
    const w = world(on, { store: await seeded(), hark: healthy, storeFails: (op, k) => op === 'set' && (k ?? '').startsWith('handoff:') })

    await $.session.start(SESSION)
    w.store.set(`handoff:${key}:0:${t36(NOW - 1000)}:other`, true)
    expect((await $.command.run(COMMAND('handoff'))).text).toBe('Another Claude Code process is handing this conversation off.')
    w.store.delete(`handoff:${key}:0:${t36(NOW - 1000)}:other`)
    expect((await $.command.run(COMMAND('handoff'))).text).toBe('Handoff saved to Hark (V-012).')
  })

  test('work recorded while end_session is in flight is not lost: it opens the next segment', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const store = await seeded()
    const w = world(on, {
      store,
      hark: (tool, args) => {
        // the background process edits src/late.ts while this end_session is on the wire: it sees segment 0 closed and opens segment 1
        if (tool === 'end_session' && !String(args.what_changed).includes('late.ts')) {
          w.store.set(Object.keys(store)[0] ?? '', first({ segment: 1, closed: false, files: ['src/late.ts'], updatedAt: NOW + 1 }))
        }
        return healthy(tool, args)
      },
    })

    await $.session.start(SESSION)
    await $.command.run(COMMAND('handoff'))
    await $.session.end(END())

    expect(w.calls.filter(c => c.tool === 'end_session').map(c => c.args.what_changed)).toEqual(['edited src/a.ts', 'edited src/late.ts'])
  })

  test('an edit made after another process handed the segment off opens the next segment and is handed off alone', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded(), hark: healthy })

    await $.session.start(SESSION)
    await block($) // boot has merged the first process's open segment
    w.store.set(await firstKey(), first({ closed: true, opened: false, handoff: 'Clean', updatedAt: NOW })) // the first process hands it off meanwhile
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.session.end(END())

    expect(w.calls.filter(c => c.tool === 'end_session').map(c => c.args.what_changed)).toEqual(['edited b.ts'])
  })

  test('parallel edits are all recorded, with another record of the conversation to merge', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded(), hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await Promise.all(['f0', 'f1', 'f2', 'f3'].map(f => $.tool.call({ tool: 'Write', file_path: `/work/${f}.ts`, content: 'x' })))
    await $.session.end(END())

    const changed = String(w.calls.find(c => c.tool === 'end_session')?.args.what_changed).split('\n').sort()
    expect(changed).toEqual(['edited f0.ts', 'edited f1.ts', 'edited f2.ts', 'edited f3.ts', 'edited src/a.ts'])
  })

  test("once a save fails, a moved conversation still hands off this process's unsaved work", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    let held = false
    const w = world(on, {
      files: { '/work/.hark/project': 'V-012\n', '/t/moved.jsonl': JSON.stringify({ type: 'continued-in' }) },
      hark: healthy,
      storeFails: op => held && op === 'set',
    })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    held = true // from here the store refuses this process's writes
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.classic.SessionEnd({ reason: 'other', transcript_path: '/t/moved.jsonl' })
    await $.session.end(END())

    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_changed).toBe('edited a.ts\nedited b.ts')
  })

  test("at exit, a held store lock doesn't hold up the handoff: each write waits at most 150 ms", { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let held = false
    let release = () => {}
    const gate = new Promise<void>(r => { release = r })
    const w = world(on, { hark: healthy, hold: () => (held ? gate : undefined) })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    held = true // another process holds the store's lock from here
    const end = $.session.end(END())
    for (let i = 0; i < 10 && !w.tools().includes('end_session'); i++) {
      for (let j = 0; j < 20; j++) await Promise.resolve() // let the hook reach its wait
      await clock.advance(50)
    }

    expect(w.tools()).toContain('end_session')
    release()
    await end
  })

  test('records that disagree on the conversation id: the first one stored names it, for every process', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const LATER = 'fedcba9876543210fedcba9876543210'
    const store = { ...(await seeded()), [`c:${await keyOf()}:${t36(NOW - 60_000)}:second`]: first({ id: LATER, latest: 'second-process', sessions: ['second-process'] }) }
    const w = world(on, { sessionId: 'third', store, hark: healthy })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.session.end(END())

    expect(JSON.parse(w.calls.find(c => c.tool === 'end_session')?.body ?? '{}').params._meta.conversation).toBe(ID)
  })

  test('a process keeps the id of its own earlier record when a newer record disagrees', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    const own = JSON.parse(w.calls[0]?.body ?? '{}').params._meta.conversation
    w.store.set(`c:${await keyOf()}:${t36(NOW)}:newer`, { ...(await mine(w)), id: 'fedcba9876543210fedcba9876543210', updatedAt: NOW + 1 })
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.session.end(END())

    expect(JSON.parse(w.calls.find(c => c.tool === 'end_session')?.body ?? '{}').params._meta.conversation).toBe(own)
  })

  test('a corrupt record is ignored, not fatal', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: { [await firstKey()]: { files: null, notes: 7, segment: 'x', allowed: 'd2' } }, hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
    expect(w.logs).toEqual([])
  })

  for (const op of ['get', 'delete'] as const) {
    test(`a store that refuses ${op} on single keys does not stop hark starting`, { options: { access_key: 'tok' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      const DAY = 24 * 60 * 60_000
      const stale = { [`c:bb:${t36(NOW - 15 * DAY)}:x`]: first({ updatedAt: NOW - 15 * DAY }), 'brief:V-001': { at: NOW - 15 * DAY, brief: BRIEF } }
      const w = world(on, { store: { ...(await seeded()), ...stale }, hark: healthy, storeFails: o => o === op })

      await $.session.start(SESSION)

      expect((await block($))[1]?.name).toBe('hark')
      expect(w.logs).toEqual([])
    })
  }

  test('a store that refuses every call: nothing is shared, the handoff still goes out, one log line', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { files: { '/work/.hark/project': 'V-012\n', '/t/moved.jsonl': JSON.stringify({ type: 'continued-in' }) }, hark: healthy, storeFails: () => true })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.classic.SessionEnd({ reason: 'other', transcript_path: '/t/moved.jsonl' }) // even after a move: no one else has this work
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toStartWith('hark: state not saved (')
  })

  test("the agent's own end_session closes the shared state, in every process", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { store: await seeded(), hark: healthy })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__hark__end_session', venture: 'V-012', what_i_did: 'x', what_changed: 'y', whats_next: 'z' } as never)

    expect(await mine(w)).toMatchObject({ closed: true, handoff: 'Clean' })
  })

  test('an Allow is saved before the edit runs', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('tool.call', { tool: 'Edit' }, () => ({ isError: true, result: 'String not found', text: 'String not found' }) as never)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(await mine(w)).toMatchObject({ allowed: ['d2'], files: [] })
  })

  test('repeated test runs are each counted, in order', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    let run = 0
    const w = world(on, { hark: healthy, bash: () => ({ result: { stdout: '', stderr: '', interrupted: false }, isError: [true, false, true][run++] }) })

    await $.session.start(SESSION)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.session.end(END())

    const did = String(w.calls.find(c => c.tool === 'end_session')?.args.what_i_did)
    expect(did).toStartWith('Claude Code session: 0 file(s) edited, 0 commit(s), 3 test run(s).\nTests npm test: failed\nTests npm test: passed\nTests npm test: failed')
  })

  test('the original process stays quiet once the conversation moved to a background process', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const rows = (...types: string[]) => types.map(type => JSON.stringify({ type })).join('\n')
    const moved = '/t/moved.jsonl', back = '/t/back.jsonl'
    const w = world(on, {
      files: { '/work/.hark/project': 'V-012\n', [moved]: rows('user', 'assistant', 'continued-in', 'user'), [back]: rows('user', 'continued-in', 'assistant') },
      hark: healthy,
    })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/src/app.ts', content: 'x' })
    await $.classic.SessionEnd({ reason: 'other', transcript_path: moved })
    await $.session.end(END())
    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries'])
    expect(w.reads).toContain(moved) // read through the host: no program runs
    expect(await mine(w)).toMatchObject({ closed: false, files: ['src/app.ts'] })

    await $.classic.SessionEnd({ reason: 'other', transcript_path: back }) // the person came back to it here
    await $.session.end(END())
    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
    expect(w.runs).toEqual([])
  })

  for (const transcript of ['/t/too-big.jsonl', '']) {
    test(`with ${transcript ? 'an unreadable transcript' : 'no transcript'}, a later process joining the conversation counts as a move`, { options: { access_key: 'tok' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      const key = await keyOf()
      const w = world(on, { hark: healthy })

      await $.session.start(SESSION)
      await block($)
      await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
      w.store.set(`c:${key}:${t36(NOW)}:background`, { ...(await mine(w)), latest: 'background', updatedAt: NOW + 1 })
      await $.classic.SessionEnd({ reason: 'other', transcript_path: transcript })
      await $.session.end(END())

      expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries'])
    })
  }

  test('with an unreadable transcript, a later record with no session id is not a move', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    w.store.set(`c:${await keyOf()}:${t36(NOW)}:anon`, { ...(await mine(w)), latest: '', updatedAt: NOW + 1 })
    await $.classic.SessionEnd({ reason: 'other', transcript_path: '/t/too-big.jsonl' })
    await $.session.end(END())

    expect(w.tools()).toContain('end_session')
  })

  test('with an unreadable transcript, the process that keeps working carries the conversation after a peek joined and left', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    // a --resume of this conversation joined, handed a.ts off and quit
    w.store.set(`c:${await keyOf()}:${t36(NOW)}:peek`, { ...(await mine(w)), latest: 'peek', closed: true, opened: false, updatedAt: NOW + 1 })
    await clock.advance(60_000)
    await $.tool.call({ tool: 'Write', file_path: '/work/later.ts', content: 'x' })
    await $.classic.SessionEnd({ reason: 'other', transcript_path: '/t/too-big.jsonl' })
    await $.session.end(END())

    expect(w.calls.filter(c => c.tool === 'end_session').map(c => c.args.what_changed)).toEqual(['edited later.ts'])
  })

  test('with an unreadable transcript, the process that got the latest prompt carries the conversation', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const key = await keyOf()
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    w.store.set(`c:${key}:${t36(NOW)}:background`, { ...(await mine(w)), latest: 'background', updatedAt: NOW + 1 })
    await clock.advance(60_000)
    await $.prompt.submit({ text: 'One more thing', wait: false, origin: { kind: 'composer' } }) // the person came back to this process
    await $.classic.SessionEnd({ reason: 'other', transcript_path: '/t/too-big.jsonl' })
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
  })

  test("the agent view's empty placeholder calls Hark only once it gets a prompt", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { env: { CLAUDE_BG_SOURCE: 'spare' }, hark: healthy })

    expect(await block($)).toHaveLength(1) // claimed: its context is computed with no prompt
    await $.session.start(SESSION)
    expect(w.calls).toEqual([])
    expect([...w.store.keys()]).toEqual([])
    await $.prompt.submit({ text: 'Fix the deposit maths', wait: false, origin: { kind: 'composer' } })
    expect(w.invalidated).toEqual(['prompt.context'])
    expect((await block($))[1]?.name).toBe('hark')
    expect(w.tools()).toEqual(['get_agent_brief'])
    await $.session.end(END())
    expect(w.tools()).toEqual(['get_agent_brief', 'close_session'])
  })

  test('a placeholder that already got a prompt is a live conversation: after a reload it starts at once', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { env: { CLAUDE_BG_SOURCE: 'spare' }, turns: 1, hark: healthy })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Write', file_path: '/work/src/app.ts', content: 'x' })
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session'])
  })

  test('new work after a handoff starts a new segment, handed off on its own, each under its own claim', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const key = await keyOf()
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.command.run(COMMAND('handoff'))
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.session.end(END())

    const ends = w.calls.filter(c => c.tool === 'end_session').map(c => c.args.what_changed)
    expect(ends).toEqual(['edited a.ts', 'edited b.ts'])
    expect(claims(w).map(k => k.split(':').slice(0, 3).join(':'))).toEqual([`handoff:${key}:0`, `handoff:${key}:1`])
  })

  test('prunes records not saved for 14 days, briefs older than 14 days and claims older than an hour, keeping the rest', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const DAY = 24 * 60 * 60_000
    const keep = { [`c:aa:${t36(NOW - 13 * DAY)}:x`]: first(), [`c:cc:${t36(NOW - 20 * DAY)}:x`]: first({ updatedAt: NOW - 60_000 }), 'brief:V-002': { at: NOW - DAY, brief: BRIEF }, [`handoff:aa:0:${t36(NOW - 50 * 60_000)}:u`]: true }
    const drop = { [`c:bb:${t36(NOW - 15 * DAY)}:x`]: first({ updatedAt: NOW - 15 * DAY }), 'brief:V-001': { at: NOW - 15 * DAY, brief: BRIEF }, [`handoff:bb:0:${t36(NOW - 61 * 60_000)}:u`]: true }
    const w = world(on, { store: { ...drop, ...keep, other: 1 }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    for (const k of Object.keys(keep)) expect(w.store.has(k), k).toBe(true)
    for (const k of Object.keys(drop)) expect(w.store.has(k), k).toBe(false)
    expect(w.store.get('other')).toBe(1) // keys hark doesn't know are left alone
  })

  test('a record of this conversation older than 14 days is merged before it is dropped', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const DAY = 24 * 60 * 60_000
    const old = `c:${await keyOf()}:${t36(NOW - 15 * DAY)}:old`
    const w = world(on, { store: { [old]: first({ updatedAt: NOW - 15 * DAY, briefAt: NOW - 15 * DAY }) }, hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/b.ts', content: 'x' })
    await $.session.end(END())

    expect(w.store.has(old)).toBe(false)
    const end = w.calls.find(c => c.tool === 'end_session')
    expect(end?.args.what_changed).toBe('edited src/a.ts\nedited b.ts')
    expect(JSON.parse(end?.body ?? '{}').params._meta.conversation).toBe(ID)
  })

  test("once this process stored its record, the conversation's records idle for 30 minutes are dropped; their work stays", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const key = await keyOf()
    const idle = `c:${key}:${t36(NOW - 2 * 60 * 60_000)}:idle`, active = `c:${key}:${t36(NOW - 2 * 60 * 60_000)}:active`
    const w = world(on, { store: { [idle]: first({ updatedAt: NOW - 31 * 60_000 }), [active]: first({ updatedAt: NOW - 60_000, files: ['src/b.ts'] }) }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect([w.store.has(idle), w.store.has(active)]).toEqual([false, true])
    const state = await mine(w)
    expect([...(state?.files as string[])].sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(state?.allowed).toEqual(['d2'])
  })

  test("when this process's record couldn't be stored, the conversation's other records are kept", { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const idle = `c:${await keyOf()}:${t36(NOW - 2 * 60 * 60_000)}:idle`
    const w = world(on, { store: { [idle]: first({ updatedAt: NOW - 31 * 60_000 }) }, hark: healthy, storeFails: (op, k) => op === 'set' && (k ?? '').startsWith('c:') })

    await $.session.start(SESSION)
    await block($)

    expect(w.store.has(idle)).toBe(true)
  })

  test('removes at most 20 expired entries per start', { options: { access_key: 'tok' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const expired = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`brief:V-${100 + i}`, { at: NOW - 15 * 24 * 60 * 60_000, brief: BRIEF }]))
    const w = world(on, { store: expired, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect([...w.store.keys()].filter(k => k.startsWith('brief:V-1'))).toHaveLength(5)
  })

  test('/clear starts a new conversation with its own key and state', { options: { access_key: 'tok' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let started = STARTED
    const w = world(on, { started: () => started, hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    started = NOW + 1000 // Claude Code restarts the conversation's clock at /clear
    await clock.advance(1000)
    await $.session.end(END('clear'))
    await block($)

    const [one, two] = w.calls.filter(c => c.tool === 'get_agent_brief').map(c => JSON.parse(c.body).params._meta.conversation)
    expect(await mine(w)).toMatchObject({ id: one, closed: true })
    expect(await mine(w, await keyOf('/work', NOW + 1000))).toMatchObject({ id: two, closed: false, files: [] })
    expect(one).not.toBe(two)
  })
})
