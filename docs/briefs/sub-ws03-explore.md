# WS-03 explore brief (brief 94)

Repo: worktree `.worktrees/ws03-menu` (branch ws/ws03-menu = milestone/m1 4a040820). Read-only.
Card texts: `docs/briefs/sub-ws03-cards.txt` (`bd show legend-<id>` gives full text).

For EACH card in your area report (max ~40 lines total):

- State on this branch: done / partial / missing (cite file:line evidence).
- Exact files + functions to change, and existing test files covering them.
- Needs migration? (look at packages/db or apps/api migrations dir, highest number).
- Overlap risk: files another card in your area also touches.
- How tests run for that file (vitest file path; needs Postgres?).
  Do not propose big designs. Facts only.

Areas:

- E1 guest auth/rate limit: legend-7csf, legend-6ipw, legend-fpi9, legend-rml8, legend-gjf1 (state only)
- E2 guest menu reads: legend-otyi, legend-lf8g, legend-49pw, legend-nx3f, legend-cpq2
- E3 schedulers/realtime/service requests: legend-1am2, legend-xlzl, legend-khiv, legend-2nb9, legend-6ohy, legend-8pye
- E4 menu back office: legend-n1p1, legend-ogzf, legend-dcz0, legend-un0j, legend-l8zb
