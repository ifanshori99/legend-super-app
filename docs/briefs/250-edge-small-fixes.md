# Brief: engineer (Sonnet) — tiga perbaikan kecil edge

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-small-fixes` dari `milestone/m1` terbaru (4c818489 atau lebih baru). Worktree `.worktrees/edge-small-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Berurutan, satu commit per kartu. Sebelum tiap kartu: `bd show` + komentar, cek ulang ke basis (triase 9 Nov memakai grep ringan; sudah ada: komentari kartu dan lewati). Ringkasan: `docs/briefs/245-triage-result.md`.
1. `legend-oark` (K): loop tarik PIN staf di edge (`GET /api/edge/staff-pin-records` → `applyStaffPinRecords`), `apps/api/src/edge/staff-pin-pull.ts`.
2. `legend-6xcy` (S): sambungkan loop master sync edge ke runtime edge (`apps/api/src/edge/runtime.ts`).
3. `legend-jm5c` (K): sweep refund (payout + eskalasi) tidak boleh jalan di worker edge (`worker-main.ts`).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: `apps/api/src/edge/*`, `worker-main.ts` (hanya gating sweep refund), test edge. Jangan: allowlist edge `mode.ts` (thread expo baru mengubahnya), payment-failover, refund service, migrasi (butuh: berhenti dan lapor), UI.

## Bukti selesai
- Per kartu: test gagal-dulu, lalu lulus. Test edge terkait tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- Typecheck api via `heavy` sekali di akhir, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan. Maks 2 subagent bersamaan; test-writer hanya menjalankan file yang ia tulis.
- Brief Codex `docs/briefs/250b-second-opinion-edge-small-fixes.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA atau "sudah ada"), bukti, file berubah, risiko, jumlah subagent.
