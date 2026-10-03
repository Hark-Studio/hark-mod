import { describe, expect, mock, test } from 'claude-code/testing'

import { BRIEF, COMMAND, EDIT, END, ENDPOINT, MESSAGES, SESSION, TURN, UUID, healthy, rpc, world } from './world'

type Blocks = { blocks: readonly { name: string; text: string }[] }
const block = async ($: { prompt: { context: (e: Blocks) => Promise<Blocks> } }) =>
  (await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-03' }] })).blocks

describe('brief', () => {
  test('rides the first message as a delimited block, with the status line', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('falls back to the keychain when HARK_TOKEN is unset', async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    const w = world(on, { hark: healthy, keychain: 'kc-token' })

    await $.session.start(SESSION)
    await block($)

    expect(w.runs[0]).toEqual(['security', 'find-generic-password', '-s', 'hark', '-w'])
    expect(w.calls[0]?.headers.authorization).toBe('Bearer kc-token')
  })

  test("accepts HARK_PAT and a .hark file (venture=V-###), as Hark's own installer writes them", async ($, on) => {
    mock.env(on, { HARK_PAT: 'pat' })
    mock.clock(on)
    const w = world(on, { files: { '/work/.hark': 'venture=V-034\n' }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.calls[0]?.args.venture).toBe('V-034')
    expect(w.calls[0]?.headers.authorization).toBe('Bearer pat')
  })

  test('HARK_TOKEN wins over HARK_PAT, and the nearest project file wins', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok', HARK_PAT: 'pat' })
    mock.clock(on)
    const w = world(on, { cwd: '/work/app', files: { '/work/app/.hark/project': 'V-001', '/work/.hark': 'venture=V-034' }, hark: healthy })

    await $.session.start(SESSION)
    await block($)

    expect(w.calls[0]?.args.venture).toBe('V-001')
    expect(w.calls[0]?.headers.authorization).toBe('Bearer tok')
  })

  test('finds .hark/project in a parent folder and works relative to it', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { cwd: '/work/packages/app', hark: healthy })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(w.calls[0]?.args.venture).toBe('V-012')
    expect(w.asks[0]?.question).toContain('Edit src/db/users.ts')
  })

  test('does nothing outside a Hark project', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('fails open with one log line when Hark is down', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('a hung server is cut off after 3 s', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    const clock = mock.clock(on)
    const w = world(on, { hark: async () => (await clock.sleep(60_000), healthy('get_agent_brief')) })

    await $.session.start(SESSION)
    const pending = block($)
    await clock.advance(3_000)

    expect(await pending).toHaveLength(1)
    expect(w.logs).toEqual(['hark: brief unavailable (no reply in 3000ms)'])
  })

  test('reads a streamed (SSE) reply', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const sse = `id: 0\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${rpc(1, BRIEF)}\n\n`
    world(on, { hark: () => ({ text: sse, headers: { 'content-type': 'text/event-stream' } }) })

    await $.session.start(SESSION)

    expect((await block($))[1]?.text).toContain('"identity"')
  })

  test('shows Draft when an earlier session left a draft handoff', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: () => ({ result: { ...BRIEF, handoff: { ...BRIEF.handoff, draft: { session_id: 'x' } } } }) })

    await $.session.start(SESSION)
    await block($)

    expect(w.statuses).toEqual(['Hark V-012 · Draft · 2 need you'])
  })
})

describe('compaction', () => {
  test('re-injects the sub-brief: decisions, non-goals, blockers, next action', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('keeps the first brief when the refresh fails; ignores precompute, subagents and skipped compactions', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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
  test('asks once per decision, with its title and why; Allow is remembered', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('Stop refuses the edit with the decision, and asks again next time', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Stop' })

    await $.session.start(SESSION)
    const r = await $.tool.call(EDIT('src/db/users.ts'))
    await $.tool.call(EDIT('src/db/users.ts'))

    expect(r.deny).toBe('Stopped by the user: Edit src/db/users.ts (-1 +1 lines) conflicts with Hark Decision "Raw SQL, no ORM" (Queries stay reviewable). Do not retry it; ask the user how to proceed.')
    expect(w.asks).toHaveLength(2)
  })

  test('reads scope from titles, body lines and non-goals; skips unscoped or unaccepted records', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/app.ts'))
    await $.tool.call(EDIT('lib/pay.ts', 'rebilling()'))
    await $.tool.call(EDIT('lib/pay.ts', 'charge(billing)'))
    await $.tool.call({ tool: 'Write', file_path: '/work/src/wallet/keys.ts', content: 'k' })

    expect(w.asks.map(a => a.question.split('\n')[0])).toEqual([
      'Decision "Stripe is the only processor" covers this edit.',
      'Non-goal "No custodial wallets" covers this edit.',
    ])
    expect(w.asks[0]?.question).toContain('Why: One reconciliation path.\n\n')
  })

  test("prefers Hark's structured scope field over a marker in the text", async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('deploy/app.yaml'))
    await $.tool.call(EDIT('infra/main.tf'))

    expect(w.asks.map(a => a.question.split('\n')[0])).toEqual(['Decision "Infra via Terraform" covers this edit.'])
  })

  test('one question lists every matching record; Allow covers them all', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/db/billing.ts'))
    await $.tool.call(EDIT('src/db/x.ts', 'billing'))

    expect(w.asks).toHaveLength(1)
    expect(w.asks[0]?.question).toContain('Decision "Raw SQL, no ORM" covers this edit.')
    expect(w.asks[0]?.question).toContain('Decision "Stripe is the only processor" covers this edit.')
  })

  test('a dismissed question lets the edit through and says so', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => null })

    await $.session.start(SESSION)
    const r = await $.tool.call(EDIT('src/db/users.ts'))

    expect(r.deny).toBeUndefined()
    expect(w.logs).toEqual(['hark: could not ask about Decision "Raw SQL, no ORM"; the edit went ahead'])
  })

  test('parallel edits each ask for themselves', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Stop' })

    await $.session.start(SESSION)
    const [a, b] = await Promise.all([$.tool.call(EDIT('src/db/a.ts')), $.tool.call(EDIT('src/db/b.ts'))])

    expect(w.asks).toHaveLength(2)
    expect(a.deny).toContain('Stopped by the user')
    expect(b.deny).toContain('Stopped by the user')
  })

  test('NotebookEdit is guarded; edits outside the project are neither guarded nor recorded', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/nb/pay.ipynb', new_source: 'billing\nmore' })
    await $.tool.call({ tool: 'Edit', file_path: '/Users/me/other/src/db/x.ts', old_string: 'a', new_string: 'b' })
    await $.session.end(END())

    expect(w.asks.map(a => a.question.split('\n\n')[1])).toEqual(['NotebookEdit nb/pay.ipynb (-0 +2 lines)'])
    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_changed).toBe('edited nb/pay.ipynb')
    expect(w.sent()).not.toContain('/Users/me')
  })

  test('decisions that fail to load are retried a minute later, not on every edit', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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
  const COMMIT = '[main abc1234def] Add the guard\n 1 file changed'
  const bash = (cmd: string) => cmd.startsWith('git commit')
    ? { result: { stdout: `[INFO] token=abc\n${COMMIT}`, stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abc1234def', kind: 'committed' } } } }
    : { result: { stdout: 'tests ok', stderr: '', interrupted: false }, isError: cmd.includes('pytest') }

  test('end_session carries files, commits, tests and agent notes, never contents', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('agent notes lose credentials, open or tilde code fences and the access key', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok-9f8e7d6c5b4a' })
    mock.clock(on)
    const w = world(on, { hark: healthy })
    const notes = [
      'Wired Stripe: set STRIPE_SECRET_KEY=sk_live_51Hxyzabcdefghij and DATABASE_URL=postgres://admin:hunter2@db.internal/prod.',
      'The key tok-9f8e7d6c5b4a works.',
      '~~~env\nDB_PASSWORD=hunter2\n~~~',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
      '```env\nSESSION_SECRET=s3cr3t-value',
    ].join('\n')

    await $.session.start(SESSION)
    await $.tool.call(EDIT('src/app.ts'))
    await $.turn.complete(TURN(notes))
    await $.turn.complete(TURN('partial ```ts\nconst leaked = 1', { reason: 'aborted', isAborted: true }))
    await $.turn.complete(TURN('subagent notes', { agentId: 'a1' }))
    await $.session.end(END())

    expect(w.sent()).not.toMatch(/sk_live|hunter2|tok-9f8e|b3Blbn|s3cr3t|leaked|subagent notes/)
    expect(w.calls.find(c => c.tool === 'end_session')?.args.what_i_did).toContain('Wired Stripe: set [redacted] and DATABASE_URL=postgres://[redacted]@db.internal/prod.')
  })

  test('without a Next steps section, whats_next comes from what happened; links stop at 10, PRs first', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('falls back to session_stopped when Hark refuses end_session', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: tool => (tool === 'end_session' ? { result: 'plan cap reached', isError: true } : healthy(tool)) })

    await $.session.start(SESSION)
    await block($)
    await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' })
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'list_journal_entries', 'end_session', 'session_stopped'])
    expect(w.calls.at(-1)?.args).toEqual({ venture: 'V-012' })
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Draft · 2 need you')
    expect(w.logs).toEqual(['hark: end_session failed ("plan cap reached")'])
  })

  test('a timed-out end_session is not followed by session_stopped', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('a session without edits, commits or tests closes without a handoff', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    await $.turn.complete(TURN('Here is how the parser works.'))
    await $.session.end(END())

    expect(w.tools()).toEqual(['get_agent_brief', 'close_session'])
  })

  test('skips its own handoff when the agent already wrote one, but not when that failed', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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

  test('/clear and resume hand off, forget Allow answers, and the next conversation gets a full brief', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy, answer: () => 'Allow' })

    await $.session.start(SESSION)
    await block($)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    await $.tool.call(EDIT('src/db/users.ts'))
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
  test('brief prints a readable brief', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    world(on, { hark: healthy })

    await $.session.start(SESSION)
    const { text } = await $.command.run(COMMAND(''))

    expect(text).toStartWith('**Hark V-012** · Open · 2 need you\n\nProject:\nstx ditto (V-012) · stage live\nPhase: beta\nShipping copy trades')
    expect(text).toContain('Next action:\n- Wire Rialto swaps\n- Polish receipts')
  })

  test('needs lists proposals and updates the count', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    await block($)
    const { text } = await $.command.run(COMMAND('needs'))

    expect(text).toBe('**3 need you** (review at https://harkstudio.io)\n- decision: Adopt Rialto\n- proposed blockers\n- proposed summary')
    expect(w.statuses.at(-1)).toBe('Hark V-012 · Open · 3 need you')
  })

  test('open resolves the project page once and opens it', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
    mock.clock(on)
    const w = world(on, { hark: healthy })

    await $.session.start(SESSION)
    const { text } = await $.command.run(COMMAND('open'))
    await $.command.run(COMMAND('open'))

    expect(w.runs.at(-1)).toEqual(['open', `https://harkstudio.io/ventures/${UUID}`])
    expect(text).toBe(`Opened [V-012 on Hark](https://harkstudio.io/ventures/${UUID})`)
    expect(w.tools().filter(t => t === 'get_venture')).toHaveLength(1)
  })

  test('handoff ends the session now, exit adds nothing; unknown words print usage', async ($, on) => {
    mock.env(on, { HARK_TOKEN: 'tok' })
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
