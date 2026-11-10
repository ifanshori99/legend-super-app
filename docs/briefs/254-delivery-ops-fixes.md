# Brief: engineer (Sonnet) — delivery channel, menu tamu, healthcheck worker

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/delivery-ops-fixes` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/delivery-ops-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Berurutan, satu commit per kartu. Sebelum tiap kartu: `bd show` + komentar, cek ulang ke basis (triase memakai grep ringan; sudah ada: komentari kartu dan lewati).
1. `legend-z649` (S): healthcheck service worker di compose single-VM (`deploy/single-vm/compose.yaml`), pakai mekanisme yang sudah ada di worker atau tambahkan yang ringan.
2. `legend-otyi` (S): baca menu tamu yang tersisa (POS picker, `/api/public/site` home) menerapkan filter foto Q23.
3. `legend-cbd0` (S): delivery channel — endpoint buat/tautkan channel, `closedUntil` buka otomatis, test wiring sweep.
4. `legend-bk99` (S): panggilan platform delivery lewat intent pasca-commit, bukan di dalam transaksi berkunci (pola outbox yang sudah ada).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: berkas yang disebut kartu, service/route delivery dan guest menu, compose single-VM, test. Jangan: payment/refund, pickup/expo, akses, migrasi (butuh: berhenti untuk kartu itu dan lapor), UI.

## Bukti selesai
- Per kartu: test gagal-dulu (z649: bukti compose config valid dan healthcheck jalan bila memungkinkan tanpa build berat), lalu lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- Typecheck via `heavy` sekali di akhir, eslint, prettier. Jangan `pnpm check` penuh. Jangan docker build.
- Review (Q48): satu `reviewer` sonnet untuk diff gabungan; bila bk99 menyentuh transaksi/outbox, pakai satu `architect` sebagai gantinya. Maks 2 subagent bersamaan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA atau "sudah ada"), bukti, file berubah, risiko, jumlah subagent.
