# daily-dashboard — rules for every Claude session

## Every project change must be reflected in the daily routine

The dashboard is kept current by an unattended morning routine, `dashboard-morning-refresh`.
It only knows what its spec tells it. A change that is not carried into the routine either
breaks the next refresh or is silently undone by it.

**Before you finish any change to this project, ask: does the morning refresh need to know?**
It does when the change touches any of these:

- the shape of `sleep-data.json`, `training-data.json` or `strength-data.json` (new or renamed keys, new arrays, units, rounding);
- how an HTML page reads those files, so the refresh must write a new value or convention;
- `tools/*.py`, `tools/strength-config.json`, their flags, exit codes, secrets or cache paths;
- the hevy-hook Worker endpoints that `tools/strava_sync.py` calls;
- metric names, windows, night attribution, narrative slots or the ban list;
- the list of files the routine may stage or must never touch.

If yes, update **all three places** in the same piece of work:

| Where | What | Machine |
|---|---|---|
| `REFRESH.md` (this repo) | The authoritative spec. Most changes belong only here, because both task files tell the agent to follow it. | both, via git |
| `C:\Users\patri\.claude\scheduled-tasks\dashboard-morning-refresh\SKILL.md` | PC task prompt. FALLBACK role, one try at ~08:45. | PC (strix-5080) |
| `~/.claude/scheduled-tasks/dashboard-morning-refresh/SKILL.md` | Mac task prompt. PRIMARY role, four tries 06:00–07:30, clone `/Users/patrikpen/daily-dashboard`. | Mac mini, `ssh patriks-mac-mini` |

Rules for the two task files:

- Change a task file only when the prompt itself must change (new step, new gate, new command). Otherwise change `REFRESH.md` only.
- Keep the two task files in step. They may differ only in role (primary vs fallback), paths, the Python binary and environment notes. Check with a diff after editing.
- Back up the Mac file before editing it (`SKILL.md.bak-<date>`). The task file is re-read on each run, so no app restart is needed. Editing the Mac scheduler registry (`scheduled-tasks.json`) does need the app quit first.
- Push repo changes to `origin/main`. The Mac clone only sees them after its step-0 pull.
- If no update is needed, say so in your final report in one line, so the owner can see it was checked.

## Other standing rules

- Stage files by name. Never `git add .` or `git add -A`.
- `data.json`, `weight-data.json` and `clinical-data.json` are manual. Change them only on an explicit user request.
- Persistent caches go under `C:\Users\patri\.claude\cache\daily-dashboard\` (Mac: `~/.claude/cache/daily-dashboard/`), never `%TEMP%`.
