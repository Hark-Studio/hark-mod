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

From this repository, [github.com/Hark-Studio/hark-mod](https://github.com/Hark-Studio/hark-mod), in a Claude Code session:

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

Before an `Edit`, `Write` or `NotebookEdit` of a file inside the project, the plugin checks the file's path against Hark records that carry a scope. It runs these checks locally, and nothing about the edit is sent to Hark. The changed text is never matched.

- **Decisions** come from the project's decision log, fetched on the first edit and again after each compaction. If the fetch fails, the guard uses non-goals alone and tries again a minute later.
- **Only settled records count.** Proposals waiting for a person (`status: candidate`, `acceptance: proposed`), rejected records, and superseded or retired records are skipped.
- **Non-goals** come from the brief.
- **Scope** comes from Hark's structured fields when a record has them:
  - **paths**: `scope.paths` (also `scope_paths`, `paths`, `files`). These are globs such as `src/db/**` or `*.sql`.
  - **areas**: `scope_area` (also `scope.areas`, `areas`, `area`). These are words such as `billing`.

  A record without them can carry its scope in its text, where a value with `/`, `*`, `?` or `.` is a path and a bare word is an area:
  - a `(scope: …)` marker in the title, for example `Raw SQL, no ORM (scope: src/db/**)`;
  - a `scope:` line in the body, for example `scope: billing`.

  The structured fields win over the text. `scope_version` and `scope_audience` are never treated as a file or area scope.
- **Matching:**
  - A record with paths matches only files those globs cover; its areas then map to those paths.
  - A record with areas but no paths matches the files under a directory named after the area. For example, `billing` covers `src/billing/deposit.ts`, but not `lib/billing.ts` and not a comment that mentions billing. Case is ignored.
- Records without a scope never trigger the guard.

When an edit matches, Claude Code asks once, in its own question dialog. The question lists every matching record's title and why.
- **Allow** is remembered for those records for the rest of the conversation, including its other processes and a later `--resume`.
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

Four cases skip the handoff:
- A session with no edits, commits or test runs (only questions and answers, say) closes its Hark session with `close_session` and writes no handoff.
- If Claude itself already wrote a Hark handoff (an `end_session` tool call that succeeded), that work isn't recorded twice.
- If another Claude Code process of the same conversation already handed the work off, this one sends nothing for it.
- If the conversation moved to a background process, the process it left sends nothing; the background process hands off instead. See [One conversation, several processes](#one-conversation-several-processes).

Claude Code gives all exit hooks together about 1.5 seconds. The plugin sends one request in that window and leaves 0.4 seconds for the hooks after it.

## Every outbound request

All network traffic is HTTPS `POST https://harkstudio.io/mcp`: one stateless MCP JSON-RPC `tools/call` per request. Each request is abandoned after 3 seconds. At exit the limit is shorter: the rest of the exit window, minus 0.4 seconds.

| Tool | When | Arguments sent |
| --- | --- | --- |
| *every request below* | Always | Headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <your access key>`, `User-Agent: hark-mod/<version> (claude-code/<version>)` (the plugin's version from `plugin.json` and the Claude Code version, for example `hark-mod/0.2.0 (claude-code/2.1.288)`), `X-Hark-Client: claude-code-mod`; and in the JSON-RPC body, beside the tool's `name` and `arguments`, `params._meta.client: "claude-code-mod"` and `params._meta.conversation: "<conversation id>"` (32 random hex characters, the same in every process of one conversation; it reveals nothing about your machine; see [One conversation, several processes](#one-conversation-several-processes)) |
| `get_agent_brief` | Session start, unless another process of this conversation saved its state in the last 30 minutes (the agent view's empty placeholder waits for its first message); after each compaction; `/hark brief`; the first message after `/clear` or a resume | `venture` (project code), `depth: "compact"` |
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
| `mkdir -p -m 700 <state folder>`, then `chmod 700 <state folder>` | Start-up, so the state folder is readable by you alone |
| `mkdir <state folder>/<key>.<segment>.lock` | Just before a handoff, so only one process sends it |
| `tail -c 65536 <transcript>` (falling back to reading the file) | At session end, to see whether the conversation moved to a background process |

**Never sent:** file contents, diffs, edit text, your prompts, the transcript (only the cleaned agent notes described above), tool output (only a commit's subject line, cleaned the same way), environment variables, or the access key except in the `Authorization` header. Files outside the project are neither guarded nor reported. The edit guard's matching happens on your machine.

## One conversation, several processes

Claude Code can move a conversation into a background process: Left arrow on an empty prompt, or `/background`. `claude --resume` also starts a new process on an old conversation. Each process loads its own copy of hark, and the copies share a small state file, so they act as one.

- **Finding the conversation.** Every process of one conversation computes the same local key: a SHA-256 of the project root and the conversation's first launch time (`startedAt` in Claude Code's plugin API). A background move and `--resume` keep that time, and `/clear` starts a new one. The key only names the state file; it never leaves your machine.
- **The conversation id sent to Hark** is 32 random hex characters, created by the first process and kept in the state file. It goes out on every request as `params._meta.conversation`, so Hark can reuse the conversation's open session instead of opening another.
- **The state folder** is `$CLAUDE_CONFIG_DIR/hark` (by default `~/.claude/hark`). Where Claude Code can run commands, it is created readable by you alone. It holds one `<key>.json` per conversation, plus a `<key>.<segment>.lock` folder per handoff, kept until you delete them. Each file holds:
  - the files, commits, test runs and pull request links seen since the last handoff, and Claude's latest notes, cleaned as described above;
  - the decisions you allowed in the edit guard;
  - the last brief and when it was fetched;
  - whether a Hark session is open and whether this work was already handed off;
  - the Claude Code session ids that carried the conversation.
- **A second process resumes the conversation.** While the state is under 30 minutes old it reuses the saved brief, injecting it without calling Hark, and it keeps your Allow answers and the work recorded so far.
- **At most one handoff per piece of work.** Before handing off, a process takes a lock with `mkdir`, which only one process can win, and marks the work closed before it sends anything. Another process ending later sends nothing for that work. Work done after a handoff, including after `/hark handoff`, starts a new segment and gets its own handoff. A lock older than 30 seconds was left by a process that died mid-handoff, and is ignored.
- **The original process stays quiet after a move.** If its transcript ends with the move to the background, it leaves the handoff to the process that now carries the conversation (`claude stop <id>`, or quitting it, ends that one). When the transcript can't be read, the state file's record of the latest process to join decides.
- **The agent view's empty "new session" placeholder** makes no Hark call, and writes no state, until someone gives it a task.

Limits:
- The lock needs a `mkdir` command; stock Windows has none, so there the closed flag alone guards against a second handoff.
- A deliberate fork in the same folder (`claude --resume <id> --fork-session`) keeps the original's launch time, so it shares the original's state, Allow answers and handoff.
- Without `HOME`, `USERPROFILE` or `CLAUDE_CONFIG_DIR`, or when the state folder can't be written, nothing is shared. Each process then hands off its own work, as in 0.1.0.

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

If you installed it from the directory, use `hark@claude-plugins-official` instead. To remove the access key too, run `security delete-generic-password -s hark` on macOS or `secret-tool clear service hark` on Linux. You can also unset `HARK_TOKEN` or `HARK_PAT`. Delete `$CLAUDE_CONFIG_DIR/hark/` (by default `~/.claude/hark/`) to remove the plugin's conversation state.

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

## Changelog

### 0.2.0 (2026-10-03)

- The edit guard matches areas by directory, never by the changed text: `billing` covers files under a `billing/` folder, or under the record's `scope.paths` when it has any. A comment that merely mentions "booking" no longer asks about booking decisions.
- Background sessions and `--resume`: hark finds each conversation by a stable local key and shares its state between processes through `~/.claude/hark/<key>.json`. A conversation moved to a background process keeps its brief, its edits and your Allow answers, and its work is handed off at most once.
- Every request carries `params._meta.conversation`, a random id per conversation, so Hark can reuse the conversation's open session.
- Repeated test runs are each counted in the handoff.
- The agent view's empty placeholder session no longer fetches a brief.
- Every request names the mod: `User-Agent: hark-mod/<version> (claude-code/<version>)`, `X-Hark-Client: claude-code-mod`, and `params._meta.client`.

### 0.1.0 (2026-10-03)

- First release: the brief on the first message, the recap after compaction, the edit guard, the handoff, the status line and `/hark`.

## License

MIT. See [LICENSE](LICENSE).
