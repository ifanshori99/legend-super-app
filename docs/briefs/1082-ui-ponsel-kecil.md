# Brief: ui-engineer — UI ponsel kecil (6 kartu, tingkat S)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md` (bagian yang relevan saja, Grep dulu), dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`.
1. `legend-96pb8` celah 16px footer PosPanel di 360px (pos-panel.tsx:42).
2. `legend-jwpbp` judul terpotong di 390 (operations-shell.tsx:136).
3. `legend-huz8` (stations-page.tsx:188).
4. `legend-gyq04` KELOLA_OUTLET_SCOPED_PREFIXES (outlet-selection.ts:28).
5. `legend-n5s1j` dukungan serverNow.
6. `legend-ibvy3` dua queryKey storage-capabilities.
Baca `bd show` tiap kartu untuk AC. Tanpa desain baru: ikuti pola layar yang ada. Bila satu kartu ternyata butuh keputusan desain baru, lewati dan laporkan.

## Pembagian paralel
- implementer per kartu (file terpisah; 5 dan 6 boleh satu implementer bila file sama).
- test-runner: pemegang token heavy (typecheck web sekali, test terarah, screenshot 360/390/1280 via `heavy`).
- ui-auditor: satu audit atas layar yang berubah.
- reviewer sonnet: diff akhir.

## Bukti selesai
Screenshot sebelum/sesudah di 360 atau 390 dan 1280 (simpan `docs/review/img/1082-*.png`), test terarah/unit lulus, typecheck web lulus, text-contract bila teks UI berubah.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Matikan dev server/browser milikmu sesudah selesai.

## Sebelum melapor
Pra-gate AGENTS.md (prettier, eslint, text-contract, typecheck web lewat `heavy`). Commit di cabang `ws/1082-ui-ponsel`, push tanpa `--force`.

## Laporan
Hasil per kartu, path screenshot, berkas, commit, cabang, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
