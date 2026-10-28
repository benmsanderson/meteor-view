# meteor-view

Browser explorer for the METEOR climate emulator, live (unlisted) at
<https://benmsanderson.github.io/meteor-view/>.

**Start with [`docs/07-handoff.md`](docs/07-handoff.md)**: current state, data
provenance, decisions already made, and how to work on the CICERO machine.

Rules that matter most:

- Never touch `../METEOR` (Ben's own working copy). Use `../meteor-work/`.
- Branch from `claude/youthful-brahmagupta-la5z3o` (the default branch) and
  open PRs against it. Ask before merging, and before deleting anything.
- Load Node first: `source /etc/profile.d/z00_lmod.sh; module load nodejs/20.13.1-GCCcore-13.3.0`.
- `npm test` must pass; `npm run build` rebuilds the summaries (~17 min, cached
  by content hash).
