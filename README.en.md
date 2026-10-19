# dsh-closeout

> Run this **before** you archive or delete an AI coding session: what still lives only on disk?

A zero-dependency CLI plus a skill (agent instructions). It answers one question at the moment you are about to close a window:
*which of my work has not been written anywhere durable yet?*

```bash
npx dsh-closeout
```

```text
Repositories:
  ! D:/work/api        [main]  modified 2, untracked 1
      src/router.ts
      docs/plan.md
  + D:/work/web        [main]  clean

Recently written files (last 12h):
  ! D:/work/tmp
      probe.ts  3 KB

summary: 2 warning(s)
```

## Why

Three things actually happened in my own sessions:

1. A "scoped" `git add <file>` still carried another session's two lines inside that file into my commit.
2. A script exited `0` with empty output; I read "no error" as success and kept going.
3. The same script silently no-op'd under a scheduler because it had no BOM — `exit 0`, no log, nothing done.

None of those were code bugs. They were all *"nobody asked one question before closing"*.
So the mechanical part — what is actually on disk — became a command; the judgement part stays in the skill.

## What it checks

| Check | How | Why it stays valid |
|---|---|---|
| Uncommitted work | `git status --porcelain`, split into staged / modified / untracked | stable git plumbing |
| Ahead / behind upstream | `git rev-list --left-right --count @{u}...HEAD` | same |
| Files written recently | `mtime > now - N hours`, skipping `node_modules` / `_trash` / `.git` | filesystem fact |
| Repo discovery | cwd if it is a repo, else direct children containing `.git` | no guessing |

What it deliberately does **not** do: parse session logs (private, unversioned formats), read your notes app,
or modify anything. It is read-only.

## Install

```bash
npx dsh-closeout                          # one-off
npm i -g dsh-closeout && closeout --zh    # global command
# as a skill for an agent that supports skill directories:
git clone https://github.com/284022719/dsh-closeout ~/.dsh/skills/closeout
```

With the skill installed, saying "wrap up" or "I'm about to close this session" makes the agent run four steps:
**check → fix each warning → write a handoff note → only then close**.

## Usage

```bash
closeout                                  # auto-discover repos
closeout --repo ../api --repo ../web      # explicit (repeatable)
closeout --temp ./scratch --hours 6       # scratch dirs + recency window
closeout --json                           # machine readable
closeout --strict                         # exit 1 when a warning exists
closeout --zh                             # Chinese labels
```

Exit codes: `0` finished (warnings included), `1` with `--strict` and warnings, `2` bad arguments.

## CI

```yaml
- run: npx dsh-closeout --strict --repo . --temp ./tmp --hours 24
```

## License

MIT.
