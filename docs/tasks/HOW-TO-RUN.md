# How to run each milestone with Claude Code

You (the owner) do this once per milestone. Claude Code does the work; you review and merge.

## One-time setup

1. Create an empty **private** GitHub repo `sitemuster` (see `docs/setup/HUMAN_CHECKLIST.md` §1).
2. Clone it on your computer, unzip this spec package into it, commit and push to `main`:
   `git add . && git commit -m "spec package" && git push`
3. Install Claude Code and the GitHub CLI, then run `gh auth login`.
4. Install Docker Desktop if you want database tests to run on your machine (optional; GitHub Actions runs them anyway).
5. Open a terminal in the repo folder and run `claude`.

## Every milestone (copy-paste prompt — change NN)

```
Run milestone NN.
Read CLAUDE.md, then docs/tasks/milestone-NN.md, then every spec file it lists.
Start in plan mode: show me the plan and any spec conflicts or open questions. Wait for my OK.
After I approve: implement only milestone NN on branch milestone-NN-*, run all checks,
open a draft PR with gh, watch CI until green, fix failures, then mark the PR ready
with the full PR checklist filled in. Then stop. Do not merge. Do not start milestone NN+1.
```

## After each milestone

1. Open the PR on GitHub. Check CI is green.
2. Follow the "manual phone test" steps in the PR description. If something fails, tell Claude Code exactly what you saw.
3. Merge the PR yourself. Pull `main`. Start a **new** Claude Code session for the next milestone (`/clear` or a fresh `claude`) so context stays clean.

## Order

01 → 13 strictly. Do not skip. Milestones 06 and 07 are the core location engine; do not rush them.
Check `docs/setup/HUMAN_CHECKLIST.md` before each milestone for the accounts it needs.
