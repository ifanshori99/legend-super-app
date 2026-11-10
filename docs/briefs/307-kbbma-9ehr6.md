# Brief 307: engineer — poin pesanan latihan + lookup HP bocor

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (folder utama di cabang lain: jangan checkout di sana). Buat worktree sendiri: `git worktree add .worktrees/loyalty-training-lookup -b ws/loyalty-training-lookup milestone/m1`, kerja hanya di sana (PORT dan nama DB sendiri).

## Tujuan
1. `legend-kbbma` (P1 bug): `deliverLoyaltyEarnEvent` di `apps/api/src/services/loyalty-earn-consumer.ts` jangan memberi poin untuk pesanan latihan (`pos_orders.is_training`). Skip di sumber, tes gagal-dulu. Void/refund pesanan latihan juga tidak boleh membuat baris ledger.
2. `legend-9ehr6` (P2 bug, data pribadi): respons cari member lewat nomor HP di kasir jangan membedakan nomor terdaftar dan tidak (kode galat, status, waktu kasar). Samakan respons, atau batasi ke kasir dengan order aktif; pilih yang paling kecil dan aman, tulis alasannya di `bd comment`.

## Kartu
`legend-kbbma`, `legend-9ehr6`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- Desain: `docs/design/ws08-member-loyalty.md`.
- Cabang lain sedang menyentuh loyalty (ws/3zd1-tiers-expiry: `loyalty-earn-tier-step.ts`, `loyalty-program.service.ts`, `member.routes.ts`): ubah seminimal mungkin di file itu supaya merge train mudah.

## Scope
- Boleh: `apps/api/src/services/loyalty-*`, route/servis lookup member kasir, tes terkait, `packages/shared` hanya bila kode galat perlu.
- Jangan: migrasi baru (tidak perlu), UI, file di luar WS-08.

## Bukti selesai
- Tes gagal-dulu untuk kedua kartu (merah sebelum fix, hijau sesudah), tes loyalty terkait hijau.
- `heavy pnpm --filter api typecheck` bersih, eslint/prettier bersih pada file berubah.
- Satu reviewer: K (data pribadi) -> satu subagent `architect` effort high.

## Sebelum melapor
Commit lokal di `ws/loyalty-training-lookup`. Jangan push, jangan merge.

## Laporan
Hasil, bukti (perintah dan hasil), file berubah, SHA, risiko tersisa, yang dibutuhkan dari CTO.
