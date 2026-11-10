# Brief 103: fix batch temuan Codex P2 (procurement dan pos-shift)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`, lalu fan-out di giliran pertama.

## Kartu
Semua kartu berlabel `fix-codex`: `bd list --label fix-codex --status open`.
- Procurement: legend-qni9, legend-8a9w, legend-uokb.
- Pos-shift: legend-1hza, legend-uw47, legend-vor4.
- KDS: dua kartu berlabel `kds` (P2 lineMoves, P3 readyAt); cabang `ws/fix-codex-kds`.

Rincian file dan arah fix ada di deskripsi tiap kartu.

## Aturan
- Dua cabang dari `milestone/m1` terbaru:
  - procurement: `ws/fix-codex-procurement` di `.worktrees/fix-codex-proc`;
  - pos-shift: `ws/fix-codex-shift` di `.worktrees/fix-codex-shift`.
- Kerjakan paralel. Tiap kartu: test merah dulu.
- Review: reviewer Opus untuk pos-shift (uang), Sonnet untuk procurement.
- Gate sekali per cabang lewat `heavy`.
- Commit lokal, lalu handoff ke merge train.
