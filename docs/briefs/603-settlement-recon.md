# Brief: engineer — ledger impor settlement + endpoint rekonsiliasi gateway

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + migrasi).

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/settlement-recon`.

## Kartu
1. `legend-jlqi`: simpan laporan settlement + barisnya, isi reconciliation cases/summary; isolasi tenant (RLS), ingest idempoten, EDC-06. PRD v1.7 §3.13 (`docs/prd/`).
2. `legend-ds1o`: endpoint settlement-recon (gross, fee, net, variance dihitung server); `gateway-settlement-card.tsx` pindah ke endpoint itu (hanya ganti sumber data, tanpa ubah tampilan). PRD §3.19.
Tiap kartu: `bd update <id> --status in_progress`; lapor `--status review` + `bd comment`.

## Aturan uang (founder, wajib)
Rekonsiliasi hanya membaca dan mencatat selisih; TIDAK membuat payout, refund, atau jurnal otomatis. Test wajib: impor ulang laporan yang sama tidak menggandakan; selisih tercatat, tidak ada pihak dibayar lebih; data tenant lain tidak terbaca.

## Scope
- Boleh: skema + migrasi baru, service/route settlement-recon, kontrak shared validator/DTO, `gateway-settlement-card.tsx` (sumber data saja), test.
- Migrasi: rentang `0440-0445` saja.
- Jangan: alur pembayaran DOIT/Duitku, QRIS DP, refund, jurnal posting.

## Pembagian paralel (giliran pertama)
Explore 2 (PRD §3.13/§3.19 + skema rekonsiliasi yang ada; kartu FE + endpoint jurnal yang dipakai sekarang). test-writer: test gagal-dulu (idempoten, RLS, angka gross/fee/net/variance). implementer 2-3 (skema+migrasi; service+route; FE sumber data). Review: satu `architect` effort xhigh (uang+migrasi). Pemegang heavy: satu `test-runner`.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck api/web/shared via `heavy`; `db:generate` kosong setelah migrasi; pra-gate AGENTS.md.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
