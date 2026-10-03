# Hark — shared project memory

A Claude Code plugin (`hark-memory`) for the terminal and the desktop Code tab. It connects a session to your project on [Hark](https://harkstudio.io), so the plan, the decisions and the handoff carry over from one session (and one teammate) to the next.

- **Brief on start.** The project's compact brief arrives with your first message as a `<hark-brief>` block.
- **Plan survives compaction.** After the context is compacted, accepted decisions, non-goals, blockers and the next action come back as a `<hark-recap>` block.
- **Edit guard.** Before Claude edits a file covered by an accepted decision or non-goal, you see the decision's title and why, and choose **Allow** or **Stop**.
- **Handoff on stop.** When the session ends, Hark gets a summary: files touched, commits, test runs, and Claude's closing notes.
- **Status line.** `Hark V-012 · Open · 2 need you`: project, handoff state (Clean / Draft / Open), and how many proposals wait for a person.

The plugin is one dependency-free hooks module ([hooks/register.ts](hooks/register.ts)). If Hark is unreachable or anything goes wrong, it logs one dim line and the session carries on. It never blocks a prompt, an edit or an exit.

## Install

From the Claude plugin directory (the listing is pending; this line will work once it is live):

```
/plugin install hark-memory@claude-plugins-official
```

From this repository, [github.com/Hark-Studio/hark-mod](https://github.com/Hark-Studio/hark-mod), in a Claude Code session:

```
/plugin marketplace add Hark-Studio/hark-mod
/plugin install hark-memory@hark
```

or from a shell:

```bash
claude plugin marketplace add Hark-Studio/hark-mod
claude plugin install hark-memory@hark
```

## Setup

1. **Project.** In the project, run `hark init`. It writes the project's code (for example `V-012`) to `.hark/project`.
   - The plugin also accepts a `.hark` file holding `venture=V-012`, which is what Hark's own hook installer writes.
   - It looks in the folder Claude Code starts in, then in each parent folder, so starting inside a monorepo package works.
   - File paths are taken relative to the folder where the project file was found.
2. **Access key.** Claude Code asks for your Hark access key (a personal access token from [harkstudio.io/connections](https://harkstudio.io/connections)) when you enable the plugin. To set or change it later, run this in a session:

   ```
   /plugin configure hark-memory@hark
   ```

   - If you installed from the directory, the id is `hark-memory@claude-plugins-official`.
   - From a shell, `claude plugin configure hark-memory@hark --values-stdin` reads `{"access_key": "…"}` on stdin and applies from the next session. Pipe it from your password manager; a key typed on the command line stays in your shell history.

   The key is the plugin's `access_key` option, declared `sensitive`. Claude Code stores it in its secure credential store, not in `settings.json`, and hands it to the plugin when it loads. Changing the option reloads the plugin with the new key. The plugin never stores the key, writes it to a file or logs it; it only sends it in the `Authorization` header of its requests to Hark. This is the only way to give the plugin a key: it reads no environment variable or keychain for it.
3. Start Claude Code in the project.

Without a project file, or without a key, the plugin stays idle and sends nothing.

## `/hark`

| Command | What it does |
| --- | --- |
| `/hark brief` (or `/hark`) | Fetches and prints the current brief |
| `/hark handoff` | Ends the Hark session now and records the handoff |
| `/hark needs` | Lists the proposals waiting for a person, and updates the count |
| `/hark open` | Opens the project in your browser (Hark's studio page if the project's id can't be found) |

## What this mod does, per hook

Until the session is in a Hark project and has an access key, no hook sends or writes anything. `/hark` is still registered, and says how to set up.

**`session.start`.** This hook runs once when a session starts, and again when the plugin reloads. It registers the `/hark` command. It then:
- finds the project file;
- creates the state folder `~/.claude/hark` with permissions for you alone;
- loads this conversation's state file;
- fetches the brief with `get_agent_brief`, unless another process of the same conversation saved the state less than 30 minutes ago.

In the agent view's empty "new session" placeholder, it only registers `/hark`.

**`prompt.context`.** This hook runs when Claude Code builds the context blocks of the conversation's first message. It adds one block named `hark` holding the brief, framed as `<hark-brief project="…">`. After a compaction, it adds the sub-brief instead, framed as `<hark-recap>`. The block goes to the model only; it is not part of what you typed. In a background process this runs before `session.start`, so it can start the plugin itself. In the agent view's placeholder it adds nothing until the placeholder gets a task.

**`prompt.submit`.** This hook only notes that a prompt arrived. In the agent view's placeholder, it lets the first real task get the brief. It never changes your prompt.

**`session.compact`.** This hook runs when the conversation is compacted, in the main conversation only, not in subagents or precompute passes. It fetches a fresh brief while the summary is written. If the compaction goes through, it marks the conversation for the `<hark-recap>` block and asks Claude Code to rebuild the context.

**`tool.call`.** This hook watches three kinds of tool call:
- **`Edit`, `Write`, `MultiEdit` and `NotebookEdit`** of a file inside the project. Before the edit, it checks the file's path against scoped decisions and non-goals; see [The edit guard](#the-edit-guard). It may ask you **Allow** or **Stop**, and refuses the edit on Stop. After a successful edit, it records the file's path, relative to the project, in the state file. It sends nothing about the edit itself.
- **`Bash`**, after the command ran:
  - If the command line names a test runner (`npm test`, `pytest` and others), it records the runner's name and whether the run passed or failed. A run that was piped, sent to the background or timed out is recorded as `result unknown`.
  - From Claude Code's own report of a git commit, it records the short commit hash and the commit's subject line, cleaned like the agent notes.
  - It records a pull request URL Claude Code reports.

  It keeps nothing else from the command or its output.
- **An `end_session` call Claude makes itself**, through any MCP server whose `end_session` tool takes `what_i_did`, as Hark's does. If the call succeeds in the main conversation, the plugin marks the work as handed off, so it isn't recorded twice. Calls from subagents are ignored.

**`turn.complete`.** When a main-conversation turn ends with a complete answer, this hook keeps Claude's answer as the agent notes for the handoff, cleaned first; see [The handoff](#the-handoff). Interrupted answers and subagents' answers are ignored.

**`classic.SessionEnd`.** This hook runs just before the session ends. It reads the last 64 KB of the session's transcript, only to see whether the conversation moved to a background process, and keeps nothing from it. If the conversation moved, the process that now carries it does the handoff.

**`session.end`.** This hook runs once when the session ends: exit, `/clear`, `--resume` into another session, logout or a signal. It also runs when a `-p` run finishes. It sends the handoff with `end_session`, falling back to `session_stopped` when that fails other than by timing out. Three cases send less:
- If there was no work, it closes the Hark session with `close_session`.
- If Claude already wrote the handoff with Hark's `end_session` tool, it sends only `close_session`.
- If this plugin already handed the work off (from another process, or with `/hark handoff`), or the conversation moved, it sends nothing.

After `/clear` or a resume, the next conversation starts fresh.

**`command.run`.** This hook answers `/hark brief`, `/hark handoff`, `/hark needs` and `/hark open`.

## The edit guard

Before an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` of a file inside the project, the plugin checks the file's path against Hark records that carry a scope. It runs these checks locally, and nothing about the edit is sent to Hark. The changed text is never matched.

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

When the session ends, the plugin calls Hark's `end_session` with:

- `what_i_did`:
  - counts of files, commits and test runs;
  - each test run, for example `npm test: passed` (`result unknown` when the run was piped, sent to the background or timed out);
  - Claude's last complete answer as **agent notes**. Code blocks become `[code omitted]`. Notes are capped at 1,500 characters. These become `[redacted]`:
    - private keys and URL passwords;
    - `NAME=value` settings whose name contains KEY, SECRET, TOKEN or PASSWORD;
    - well-known token formats: `sk-`, `sk_live_`, `ghp_`, `github_pat_`, `xoxb-`, `npm_`, AWS keys, JWTs and others;
    - your own access key.

    This cleaning is best effort. Other text in the answer is sent as written, such as a password written out in prose or an indented code excerpt.
- `what_changed`: `edited <path>` for each file inside the project, and `commit <sha> <subject>` for each commit.
- `whats_next`: the "Next steps" or "Next up" section of Claude's notes. Without one, it says what to pick up: `Fix the failing test runs: …`, or `Review this session's changes to …`.
- `links`: pull request URLs, then touched paths (10 at most).
- `watch_out_for`: failing test runs, if any.

Fallbacks:
- If `end_session` fails other than by timing out (Hark answers with an error, or the connection fails), the plugin calls `session_stopped` instead, and Hark drafts the handoff from repo activity.
- If Hark doesn't answer in time, the plugin doesn't retry. Hark's own 45-minute idle sweep drafts the handoff, and it also covers a crash.

Four cases skip the handoff:
- A session with no edits, commits or test runs (only questions and answers, say) closes its Hark session with `close_session` and writes no handoff.
- If Claude itself already wrote a Hark handoff (an `end_session` tool call that succeeded), that work isn't recorded twice.
- If another Claude Code process of the same conversation already handed the work off, this one sends nothing for it.
- If the conversation moved to a background process, the process it left sends nothing; the background process hands off instead. See [One conversation, several processes](#one-conversation-several-processes).

Claude Code gives all exit hooks together about 1.5 seconds. The plugin sends one request in that window and leaves 0.4 seconds for the hooks after it.

## Every outbound request

The plugin makes no network request except these. Each one is an HTTPS `POST` to the single fixed URL `https://harkstudio.io/mcp`: one stateless MCP JSON-RPC `tools/call`. A request is abandoned after 3 seconds. At exit the limit is shorter: the rest of the exit window, minus 0.4 seconds. The last row is not a request the plugin sends: it is a page your browser opens.

| URL | Tool | When | Fields sent |
| --- | --- | --- | --- |
| `https://harkstudio.io/mcp` | *every request below* | Always | **Headers:** `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <your access key>`, `User-Agent: hark-mod/<version> (claude-code/<version>)` (for example `hark-mod/0.2.1 (claude-code/2.1.288)`), `X-Hark-Client: claude-code-mod`. **Body:** `jsonrpc`, `id`, `method: "tools/call"`, and `params` with the tool's `name`, its `arguments` (below), and `_meta: { client: "claude-code-mod", conversation: "<conversation id>" }`. The conversation id is 32 random hex characters, the same in every process of one conversation; it reveals nothing about your machine |
| `https://harkstudio.io/mcp` | `get_agent_brief` | Session start, unless another process of this conversation saved its state in the last 30 minutes (the agent view's empty placeholder waits for its first message); at each compaction, as it starts, even if another hook then skips it; `/hark brief`; the first message after `/clear` or a resume | `venture` (project code), `depth: "compact"` |
| `https://harkstudio.io/mcp` | `list_journal_entries` | The first guarded edit of a session, and the first after each compaction; a minute after a failed attempt | `venture`, `kind: "decision"`, `limit: 200` |
| `https://harkstudio.io/mcp` | `list_candidates` | `/hark needs` | `venture` |
| `https://harkstudio.io/mcp` | `get_venture` | `/hark open`, until the project's id is known, when the project file holds a code (`V-012`) rather than an id | `id_or_code` |
| `https://harkstudio.io/mcp` | `end_session` | Session end; `/hark handoff`; only when there were edits, commits or test runs | `venture`, `what_i_did`, `what_changed`, `whats_next`, `links`, optional `watch_out_for` (see [The handoff](#the-handoff)) |
| `https://harkstudio.io/mcp` | `session_stopped` | When `end_session` fails other than by timing out, and exit time is left | `venture` |
| `https://harkstudio.io/mcp` | `close_session` | Session end or `/hark handoff` with no edits, commits or test runs, or after Claude wrote its own handoff | `reason: "Claude Code session with no edits, commits or test runs"` |
| `https://harkstudio.io/ventures/<project id>`, or `https://harkstudio.io/studio` when the id is unknown | none: your browser opens it | `/hark open` | Nothing from the plugin. Your browser loads the page as it would any link, with your own harkstudio.io sign-in. The access key is not in the URL |

**Never sent:**
- file contents, diffs or edit text;
- your prompts;
- the transcript (only the cleaned agent notes described above);
- tool output (only a commit's subject line, cleaned the same way);
- environment variables;
- the access key, anywhere except the `Authorization` header.

The agent notes and commit subjects are written by Claude and by you, so their cleaning is best effort; see [The handoff](#the-handoff).

Files outside the project are neither guarded nor reported. The edit guard's matching happens on your machine.

## Commands it runs

Each command below is written at its call with a fixed executable and fixed flags; only the noted path or URL argument varies. The plugin runs no shell, no git command and no keychain tool. None of these commands makes a network request, except that `open` or `xdg-open` hands a harkstudio.io URL to your browser.

| Command | When | Why |
| --- | --- | --- |
| `mkdir -p -m 700 ~/.claude/hark`, then `chmod 700 ~/.claude/hark` | Start-up | Makes the state folder readable by you alone |
| `mkdir ~/.claude/hark/<key>.<segment>.lock` | Just before a handoff | An atomic lock, so only one process of a conversation sends its handoff. It creates an empty folder |
| `tail -c 65536 <transcript>` | Session end | Reads the end of the session's own transcript to see whether the conversation moved to a background process. If `tail` can't run, the plugin reads the file instead |
| `open <project URL>`, then `xdg-open <project URL>` if `open` fails | `/hark open` | Opens the project's page on harkstudio.io in your browser |

Commit and pull request details come from Claude Code's own report of the commands Claude ran. The plugin never runs git itself.

## The file it writes

The plugin writes one file per conversation: `~/.claude/hark/<key>.json`. It is the only file the plugin writes. Its only other disk entries are the state folder itself and the empty lock folders above, one per handoff, which stay until you delete `~/.claude/hark`.

- **Where:** `~/.claude/hark/` in your home directory (`USERPROFILE` on Windows), created readable by you alone where the system allows.
- **Name:** `<key>` is a SHA-256 of the project root and the conversation's first launch time, so every process of one conversation finds the same file. It is never sent anywhere.
- **What it holds:**
  - the conversation id sent to Hark;
  - the segment number (how many handoffs this conversation has had) and when the file was last saved;
  - the files, commits, test runs and pull request links seen since the last handoff;
  - Claude's latest notes, cleaned as described in [The handoff](#the-handoff);
  - the decisions you allowed in the edit guard;
  - the last brief and when it was fetched;
  - whether the next message should get the `<hark-recap>` block after a compaction;
  - whether a Hark session is open and whether this work was already handed off;
  - the handoff state and proposal count shown in the status line;
  - the Claude Code session ids that carried the conversation, and which one joined last.

  It never holds the access key or the transcript.
- **Who reads it:** only this plugin, in the processes of the same conversation. It reuses the cached brief and sends the recorded work in the handoff. No command or tool is given the file, and the file itself is never uploaded. (Claude's own file tools can open it like any file in your home folder.)
- **Removing it:** delete `~/.claude/hark/` at any time. The plugin starts over with fresh state.

It also reads, without writing:
- the project file (`.hark/project` or `.hark`);
- its own `plugin.json`, for the version in the `User-Agent`;
- the end of the session's transcript (above);
- the age of a handoff lock folder;
- three environment variables: `HOME` (or `USERPROFILE`) to find `~/.claude/hark`, and `CLAUDE_BG_SOURCE` to recognize the agent view's empty placeholder.

## One conversation, several processes

Claude Code can move a conversation into a background process: Left arrow on an empty prompt, or `/background`. `claude --resume` also starts a new process on an old conversation. Each process loads its own copy of the plugin, and the copies share the conversation's state file, so they act as one.

- **Finding the conversation.** Every process of one conversation computes the same local key from the project root and the conversation's first launch time (`startedAt` in Claude Code's plugin API). A background move and `--resume` keep that time, and `/clear` starts a new one.
- **The conversation id sent to Hark** is random, created by the first process and kept in the state file. It goes out on every request as `params._meta.conversation`, so Hark can reuse the conversation's open session instead of opening another.
- **A second process resumes the conversation.** While the state is under 30 minutes old it reuses the saved brief, injecting it without calling Hark, and it keeps your Allow answers and the work recorded so far.
- **At most one handoff per piece of work.** Before handing off, a process takes a lock with `mkdir`, which only one process can win, and marks the work closed before it sends anything. Another process ending later sends nothing for that work. Work done after a handoff, including after `/hark handoff`, starts a new segment and gets its own handoff. A lock older than 30 seconds was left by a process that died mid-handoff, and is ignored.
- **The original process stays quiet after a move.** If its transcript ends with the move to the background, it leaves the handoff to the process that now carries the conversation (`claude stop <id>`, or quitting it, ends that one). When the transcript can't be read, the state file's record of the latest process to join decides.
- **The agent view's empty "new session" placeholder** makes no Hark call, and writes no state, until someone gives it a task.

Limits:
- The lock needs a `mkdir` command; stock Windows has none, so there the closed flag alone guards against a second handoff.
- A deliberate fork in the same folder (`claude --resume <id> --fork-session`) keeps the original's launch time, so it shares the original's state, Allow answers and handoff.
- Without `HOME` (or `USERPROFILE`), or when `~/.claude/hark` can't be written, nothing is shared. Each process then hands off its own work, as in 0.1.0.

## Uninstall

In a Claude Code session:

```
/plugin uninstall hark-memory@hark
/plugin marketplace remove hark
```

or from a shell:

```bash
claude plugin uninstall hark-memory@hark
claude plugin marketplace remove hark
```

If you installed it from the directory, use `hark-memory@claude-plugins-official` instead. Uninstalling from the last scope it is installed in also deletes the stored access key; Claude Code asks for it again if you reinstall. Delete `~/.claude/hark/` to remove the plugin's conversation state.

## Development

```bash
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin test .
claude --plugin-dir .
```

The Claude directory requires the endpoint and every command's executable to be literal at the call. `claude plugin validate` doesn't check that, so check it by eye; each line must show the literal URL or a quoted executable:

```bash
grep -nE '\$\.(http\.fetch|process\.run)\(' hooks/register.ts
```

For type-checking, run `/plugin-types` in a Claude Code session in this folder. It writes the engine's declarations to `.claude/types`, which is gitignored. Then run `npx tsc -p tsconfig.json`.

The tests in [tests/](tests/) run against Claude Code's own hook engine with an in-memory Hark, file system and environment ([tests/world.ts](tests/world.ts)). They cover:
- the brief, compaction and the status line;
- the edit guard and its scope rules;
- the handoff, its fallbacks and `/hark`;
- one conversation across several processes;
- an unreachable, refusing or hung server;
- the privacy rules: no edit text, code or credentials leave the machine, the key is taken from the plugin's options only, and without a key nothing is sent, run or written.

## Changelog

### 0.2.1 (2026-10-03)

- The plugin's id is now `hark-memory`; its display name is unchanged. Install with `hark-memory@hark`.
- The access key comes only from the plugin's `access_key` option, which Claude Code prompts for and keeps in its secure storage. The plugin no longer reads `HARK_TOKEN`, `HARK_PAT` or a keychain item.
- Every request goes to the one fixed URL `https://harkstudio.io/mcp`. Every command the plugin runs has a fixed executable and fixed flags at its call; only a path or URL argument varies.
- The state file always lives at `~/.claude/hark/<key>.json`; `CLAUDE_CONFIG_DIR` no longer moves it.
- The README documents each hook, every outbound request, the commands the plugin runs and the one file it writes.
- `/hark` and the missing-key log line give the full `/plugin configure hark-memory@hark` command.
- An agent-view session that already had a prompt starts at once when the plugin reloads, for example after you set a new key.
- **Upgrading from 0.2.0:** run `/plugin uninstall hark@hark`, `/plugin marketplace update hark`, then `/plugin install hark-memory@hark`, and enter the key when asked. This version ignores `HARK_TOKEN`, `HARK_PAT` and the `hark` keychain item, so you can unset those variables and remove the item. If you set `CLAUDE_CONFIG_DIR`, conversations in progress during the upgrade start with fresh state.

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
