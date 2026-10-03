# Hark — shared project memory

A Claude Code plugin (`hark`) for the terminal and the desktop Code tab. It connects a session to your project on [Hark](https://harkstudio.io), so the plan, the decisions and the handoff carry over from one session (and one teammate) to the next.

- **Brief on start.** The project's compact brief arrives with your first message as a `<hark-brief>` block.
- **Plan survives compaction.** After the context is compacted, accepted decisions, non-goals, blockers and the next action come back as a `<hark-recap>` block.
- **Edit guard.** Before Claude edits a file covered by an accepted decision or non-goal, you see the decision's title and why, and choose **Allow** or **Stop**.
- **Handoff on stop.** When the session ends, Hark gets a summary: files touched, commits, test runs, and Claude's closing notes.
- **Status line.** `Hark V-012 · Open · 2 need you`: project, handoff state (Clean / Draft / Open), and how many proposals wait for a person.

The plugin is one dependency-free hooks module ([hooks/register.ts](hooks/register.ts)). If Hark is unreachable or anything goes wrong, it logs one dim line and the session carries on. It never blocks a prompt, an edit or an exit.

## Install

From the Claude plugin directory (the listing is pending; this line will work once it is live):

```
/plugin install hark@claude-plugins-official
```

From this repository, in a Claude Code session:

```
/plugin marketplace add Hark-Studio/hark-mod
/plugin install hark@hark
```

or from a shell:

```bash
claude plugin marketplace add Hark-Studio/hark-mod
claude plugin install hark@hark
```

## Setup

1. **Project.** In the project, run `hark init`. It writes the project's code (for example `V-012`) to `.hark/project`. The plugin reads, in this order:
   - `.hark/project`;
   - a `.hark` file holding `venture=V-012`, which is what Hark's own hook installer writes.

   It looks in the folder Claude Code starts in, then in each parent folder, so starting inside a monorepo package works. File paths are taken relative to the folder where the project file was found.
2. **Access key.** The first of these that is set is used:
   - the `HARK_TOKEN` environment variable;
   - the `HARK_PAT` environment variable, which Hark's own hooks use;
   - a keychain item named `hark`, on macOS and Linux only:
     - macOS: `security add-generic-password -s hark -a "$USER" -w`
     - Linux (libsecret): `secret-tool store --label=Hark service hark`

   **Windows:** set `HARK_TOKEN` (or `HARK_PAT`). The plugin doesn't read the Windows Credential Manager.
3. Start Claude Code in the project.

Without a project file the plugin stays idle and sends nothing.

## `/hark`

| Command | What it does |
| --- | --- |
| `/hark brief` (or `/hark`) | Fetches and prints the current brief |
| `/hark handoff` | Ends the Hark session now and records the handoff |
| `/hark needs` | Lists the proposals waiting for a person, and updates the count |
| `/hark open` | Opens the project in your browser (Hark's studio page if the project's id can't be found) |

## The edit guard

Before an `Edit`, `Write` or `NotebookEdit` of a file inside the project, the plugin checks the file's path and the changed text against Hark records that carry a scope. It runs these checks locally, and nothing about the edit is sent to Hark.

- **Decisions** come from the project's decision log, fetched on the first edit and again after each compaction. If the fetch fails, the guard uses non-goals alone and tries again a minute later.
- **Only settled records count.** Proposals waiting for a person (`status: candidate`, `acceptance: proposed`), rejected records, and superseded or retired records are skipped.
- **Non-goals** come from the brief.
- **Scope** is read from Hark's structured scope field, `scope_area`, when a record has one. A record without it can carry its scope in its text:
  - a `(scope: …)` marker in the title, for example `Raw SQL, no ORM (scope: src/db/**)`;
  - a `scope:` line in the body, for example `scope: billing, src/payments/**`.

  When a record has both, the structured field wins. The plugin also accepts `scope_paths`, `scope`, `paths`, `files`, `areas`, `area` and `applies_to` fields. It never treats `scope_version` or `scope_audience` as a file or area scope.
- A scope with `/`, `*`, `?` or `.` is a path glob (`src/db/**`, `*.sql`). A bare word of three letters or more (`billing`) is an area, matched as a whole word in the path or the changed text.
- Records without a scope never trigger the guard.

When an edit matches, Claude Code asks once, in its own question dialog. The question lists every matching record's title and why.
- **Allow** is remembered for those records for the rest of the session.
- **Stop** refuses that edit and tells Claude why. The next matching edit asks again, so nothing is ever blocked without you seeing it.
- If the question can't be shown (it was dismissed, or the run is headless with `-p`), the edit goes ahead and the plugin logs a line.
- Edits running in parallel, for example from two subagents, each get their own question.

## The handoff

When the session ends (exit, `/clear`, `--resume` into another session, logout, or a signal), the plugin calls Hark's `end_session` with:

- `what_i_did`:
  - counts of files, commits and test runs;
  - each test run, for example `npm test: passed` (`result unknown` when the run was piped or sent to the background);
  - Claude's last complete answer as **agent notes**. Interrupted answers and subagents' answers are never used. Code blocks become `[code omitted]`. Private keys, URL passwords, `NAME=value` settings whose name contains KEY, SECRET, TOKEN or PASSWORD, well-known token formats (`sk-`, `sk_live_`, `ghp_`, `github_pat_`, `xoxb-`, `npm_`, AWS keys, JWTs and others) and your own access key become `[redacted]`. Notes are capped at 1,500 characters.
- `what_changed`: `edited <path>` for each file inside the project, and `commit <sha> <subject>` for each commit.
- `whats_next`: the "Next steps" or "Next up" section of Claude's notes. Without one, it says what to pick up: `Fix the failing test runs: …`, or `Review this session's changes to …`.
- `links`: pull request URLs, then touched paths (10 at most).
- `watch_out_for`: failing test runs, if any.

Fallbacks:
- If Hark answers `end_session` with an error, the plugin calls `session_stopped` instead, and Hark drafts the handoff from repo activity.
- If Hark doesn't answer in time, the plugin doesn't retry. Hark's own 45-minute idle sweep drafts the handoff, and it also covers a crash.

Two cases skip the handoff:
- A session with no edits, commits or test runs (only questions and answers, say) closes its Hark session with `close_session` and writes no handoff.
- If Claude itself already wrote a Hark handoff (an `end_session` tool call that succeeded), that work isn't recorded twice.

Claude Code gives all exit hooks together about 1.5 seconds. The plugin sends one request in that window and leaves 0.4 seconds for the hooks after it.

## Every outbound request

All network traffic is HTTPS `POST https://harkstudio.io/mcp`: one stateless MCP JSON-RPC `tools/call` per request. Each request is abandoned after 3 seconds. At exit the limit is shorter: the rest of the exit window, minus 0.4 seconds.

| Tool | When | Arguments sent |
| --- | --- | --- |
| *every request below* | Always | Headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <your access key>`, `User-Agent: hark-mod/<version> (claude-code/<version>)` (the plugin's version from `plugin.json` and the Claude Code version, for example `hark-mod/0.1.0 (claude-code/2.1.288)`), `X-Hark-Client: claude-code-mod`; and in the JSON-RPC body, `params._meta.client: "claude-code-mod"` beside the tool's `name` and `arguments` |
| `get_agent_brief` | Session start; after each compaction; `/hark brief`; the first message after `/clear` or a resume | `venture` (project code), `depth: "compact"` |
| `list_journal_entries` | The first guarded edit of a session, and the first after each compaction; a minute after a failed attempt | `venture`, `kind: "decision"`, `limit: 200` |
| `list_candidates` | `/hark needs` | `venture` |
| `get_venture` | `/hark open`, until the project's id is known, when the project file holds a code (`V-012`) rather than an id | `id_or_code` |
| `end_session` | Session end; `/hark handoff`; only when there were edits, commits or test runs | `venture`, `what_i_did`, `what_changed`, `whats_next`, `links`, optional `watch_out_for` (see above) |
| `session_stopped` | When Hark answers `end_session` with an error | `venture` |
| `close_session` | Session end or `/hark handoff` with no edits, commits or test runs (including after Claude wrote its own handoff) | `reason: "Claude Code session with no edits, commits or test runs"` |

The plugin also runs these local commands. None of them makes a network request of its own:

| Command | When |
| --- | --- |
| `security find-generic-password -s hark -w` (macOS), `secret-tool lookup service hark` (Linux) | Session start, only when neither `HARK_TOKEN` nor `HARK_PAT` is set |
| `open <project URL>`, then `xdg-open <project URL>` | `/hark open` |

**Never sent:** file contents, diffs, edit text, your prompts, the transcript (only the cleaned agent notes described above), tool output (only a commit's subject line, cleaned the same way), environment variables, or the access key except in the `Authorization` header. Files outside the project are neither guarded nor reported. The edit guard's matching happens on your machine.

## Uninstall

In a Claude Code session:

```
/plugin uninstall hark@hark
/plugin marketplace remove hark
```

or from a shell:

```bash
claude plugin uninstall hark@hark
claude plugin marketplace remove hark
```

If you installed it from the directory, use `hark@claude-plugins-official` instead. To remove the access key too, run `security delete-generic-password -s hark` on macOS or `secret-tool clear service hark` on Linux. You can also unset `HARK_TOKEN` or `HARK_PAT`. The plugin keeps no files of its own.

## Development

```bash
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin test .
claude --plugin-dir .
```

For type-checking, run `/plugin-types` in a Claude Code session in this folder. It writes the engine's declarations to `.claude/types`, which is gitignored. Then run `npx tsc -p tsconfig.json`.

The tests in [tests/](tests/) run against Claude Code's own hook engine with an in-memory Hark, file system and keychain ([tests/world.ts](tests/world.ts)). They cover:
- the brief, compaction and the status line;
- the edit guard and its scope rules;
- the handoff, its fallbacks and `/hark`;
- an unreachable, refusing or hung server;
- the privacy rules: no edit text, code or credentials leave the machine.

## License

MIT. See [LICENSE](LICENSE).
