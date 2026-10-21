# dsh-closeout

> Run this **before** you archive or delete an AI coding session: what still lives only on disk — and does this session need a handoff?

A zero-dependency CLI plus a skill (agent instructions). It answers two questions and **puts the verdict first**:

> **No buttons/UI in this package** (since 2026-10-21): the composer buttons (continue / wrap-up / follow-suggestions /
> resend + closeout panel) live in the separate plugin `dsh-button`, which spawns this CLI and degrades gracefully
> when it is not installed.

1. **Can I close this?** (archiving is reversible, deleting is not — only deletion is gated)
2. **Does this session need a handoff note?** (length, day span, whether it ended cleanly)

```bash
npx dsh-closeout
```

```text
closeout — pre-close checks · session ba7ea134 · 101 tool calls · 1 day(s) · last 2026-10-20 06:55
────────────────────────────────────────────
Verdict: ✗ archive is fine; do NOT delete — 2 item(s) still only live on disk

Handoff: ! needed: over the threshold (101 calls > 300)

Must handle: 2
  ✗ D:\work\api → 1 modified / 2 untracked
      src/router.ts
      docs/plan.md
  ✗ D:\work\tmp → 12 file(s) written in the last 12h
      probe.ts  4 KB

Not checked (not the same as fine): 1
  · workspace gates (rules-lock / root registry / rules-audit) disabled: pass --local <workspace>
```

## Why

Things that actually happened in my own sessions:

1. A "scoped" `git add <file>` still carried another session's two lines inside that file into my commit.
2. A script exited `0` with empty output; I read "no error" as success and kept going.
3. The same script silently no-op'd under a scheduler because it had no BOM — `exit 0`, no log, nothing done.
4. By the 400th tool call I no longer remembered what was left undone; closing the window erased it.

The first three are disk facts, so they became a command. The fourth isn't — but the tool can still tell you
*this session is long enough to deserve a handoff note*, and generate its skeleton.

## Wrap-up flow (2026-10-21)

**Wrap-up** = ① sync (optional) → ② check (this tool) → ③ handoff (if needed) → ④ report (`--report`).
The older Chinese words «收口» (check step) and «收工» (sync step) are now steps of the same flow, not separate tools.

| Step | What | Entry |
|---|---|---|
| ① sync | commit as you go; push can wait | `tools/dsh-sync.ps1 status/push` (probed, never called) |
| ② check | uncommitted / unpushed / fresh scratch files / handoff needed | `closeout --zh` |
| ③ handoff | skeleton for the next session | `closeout --handoff --task <name>` |
| ④ report | four-section wrap-up report | `closeout --report` |

## Compared to similar tools

| Tool | What it does | Relation |
|---|---|---|
| [`git-leave`](https://github.com/mrnossiom/git-leave) | Rust CLI (`git leave`): dirty worktrees, branches ahead of upstream, branches with no upstream; multithreaded crawl | **finer-grained on git hygiene** (per-branch). This tool only summarises per repo |
| [`pendector`](https://github.com/thaim/pendector) | Rust CLI: multi-directory scan, TOML config, JSON, Slack webhook | broader; this tool trades that for **zero install** (`npx`) and no config |
| Platform stop hooks (e.g. Claude Code's `decision: block`) | run a script when a session ends, can block the stop | a stronger form of "you cannot forget"; this tool is run on demand, triggered by the skill |
| Session-handoff plugins (`dsh-handoff*`) | export the session into a handoff document | complementary: they record *what happened*, this one decides *whether you need one* and what is still only on disk |

**What is not duplicated here**: the scratch-directory check, the "should this session get a handoff" judgement,
and the three-level verdict. Everything else (dirty tree, unpushed commits) is git common sense.

### Neighbouring DSH plugins

| Plugin | What it does | Relation |
|---|---|---|
| [`shared-handoff-dsh`](https://www.npmjs.com/package/shared-handoff-dsh) | `handoff` + `task-id-bootstrap` skills: export the session and bind a task | **complementary**: it performs the handoff; this tool decides whether one is needed and builds the skeleton |
| [`@ericality/dsh-handoff`](https://www.npmjs.com/package/@ericality/dsh-handoff) | `/handoff`: persist changes, save progress, emit a continuation prompt | same space (handoff), no disk check |
| `dsh-session-handoff` (community) | session handoff plugins, GitHub-installed | same space (handoff) |
| [`dsh-session-manager`](https://www.npmjs.com/package/dsh-session-manager) | delete / archive / move / tag sessions; delete is irreversible and always confirmed | **complementary**: it does the deleting; this tool gives the "can I close" evidence |
| [`dsh-archived-chats`](https://www.npmjs.com/package/dsh-archived-chats) | archive retrieval, bulk archiving, search, recycle bin | complementary: retrieval after archiving |
| `dsh-git` | npm 0.0.1 placeholder, in development: git panel + block dirty trees | closest competitor, **not released yet** |
| `dsh-turnsnap` | auto `[turnsnap]` commit per turn | overlaps on auto-commit, different goal |

**Scope**: dsh-closeout is a **close-out verdict tool**. It does not perform handoffs (use the handoff plugins),
delete sessions (use `dsh-session-manager`), auto-commit/push (use `dsh-sync` / `dsh-git` / `dsh-turnsnap`),
or restore archives (use `dsh-archived-chats`). It answers two questions — *can I close*, *does this need a handoff* —
and prints a re-runnable checklist.

## What it checks

| Check | How | Why it stays valid |
|---|---|---|
| Uncommitted work | `git status --porcelain`, split into staged / modified / untracked | stable git plumbing |
| Ahead / behind upstream | `git rev-list --left-right --count @{u}...HEAD` | same; with no upstream it says so instead of implying "in sync" |
| Files written recently | `mtime > now - N hours`, skipping `node_modules` / `_trash` / `.git`, newest first | filesystem fact |
| Session length & how it ended | DSH session store: **event counts and timestamps only** (calls / day span / `turn/end` reason / goal blocked) | no parsing of message bodies |
| Handoff already written? | the `原会话：session-...` line inside `handoffs/*.md` | machine contract |
| Workspace gates (optional) | `--local <dir>`: `rules-lock` / `hygiene-structure` / `rules-audit` | per-workspace rules are never hardcoded |

It deliberately does **not** parse message bodies, read your notes app, or modify anything. Read-only.

## Install

```bash
npx dsh-closeout                          # one-off
npm i -g dsh-closeout && closeout --zh    # global command
```

Installing as a skill: **do not clone the repo into `skills/`** — there is no `SKILL.md` at the repo root
(it lives one level down, in `skills/closeout/`), and agents only scan `<skills>/<name>/SKILL.md`.
That mistake fails silently: the skill is never discovered and nothing reports an error.

```bash
git clone https://github.com/xinming-chenniang/dsh-closeout /tmp/dsh-closeout
mkdir -p ~/.dsh/skills/closeout
cp /tmp/dsh-closeout/skills/closeout/SKILL.md ~/.dsh/skills/closeout/
```

With the skill installed, saying "wrap up" or "I'm about to close this session" makes the agent run the unified flow:
**sync (optional) → check → handoff (if needed) → report → only then close**.

## Usage

```bash
closeout                                  # auto-discover repos
closeout --repo ../api --repo ../web      # explicit (repeatable)
closeout --temp ./scratch --hours 6       # scratch dirs + recency window
closeout --session <id>                   # default: $DSH_SESSION_ID, else the most recent one
closeout --local D:\dsh                   # also run that workspace's own gates
closeout --handoff --task "wrap up"       # write a handoff skeleton
closeout --report                         # print a wrap-up report skeleton
closeout --cwd D:\dsh --report            # inspect another working directory
closeout --json | --strict | --zh | --help
```

Exit codes: `0` finished (must-handle items included), `1` with `--strict` and something must be handled,
`2` bad arguments.

### Handoff skeleton

`closeout --handoff --task <name>` writes `~/.dsh/handoffs/<YYYYMMDD>-<name>.md` (override with `--handoffs`,
print only with `--dry-run`). It fills the "current state" section with what it already knows — session id,
call count, day span, dirty repos, scratch files — and leaves the three sections only a session can write:
*what was done / open items / rollback*. It never overwrites an existing note unless you pass `--force`.

### Wrap-up report

`closeout --report` prints a four-section skeleton (verdict / what was done / current state / open items / rollback).
`--report-out <file>` writes it to disk. Shared facts come from the same collector as the handoff skeleton, but the
report deliberately **omits the `原会话：` line** so the handoff ledger never mistakes it for a handoff note.
A "sync" section probes `tools/dsh-sync.*` and prints the commands — it never calls them.
`--cwd <dir>` inspects another working directory (default: cwd; the desktop client can use `--cwd-from-session`).

## License

MIT.
