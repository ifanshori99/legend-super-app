# Brief: engineer — kunci intent DP lintas penulis (U4) dan batas refund DP hangus (U1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/dp-intent-lock` dari `milestone/m1` a8c90378, worktree `.worktrees/dp-intent-lock`, `worktree:setup`. Jangan checkout di folder utama.

## Tujuan
1. `legend-em6p` (P1, tingkat K): waktu selesai refund, waktu selesai penjualan DP/gateway, dan waktu tutup reservasi diambil sebelum commit tanpa kunci bersama. Penjualan bercap T1 yang commit setelah refund T2 diproses bisa membuat keduanya terposting dan `customer_deposit` terdebit dua kali. Semua penulis (modul refund, `pos-order.service.ts`, `reservation-lifecycle.ts`, jalur QR bila menyentuh DP) mengunci baris `payment_intents` (`FOR UPDATE`) dulu, baru mengambil waktu fakta. Ikuti urutan kunci legend-94qt; jangan membuat deadlock baru.
2. `legend-fsl5` (P1, tingkat K): `refundableBalance` di `payment-admin.service.ts` belum mengurangi DP yang sudah hangus. Kurangi, jawab 409 `REFUND_DEPOSIT_FORFEITED`, di atas penahan e7zj (`REFUND_DEPOSIT_IN_USE`).

## Kartu
`legend-em6p` dan `legend-fsl5`. Di awal: `ghostex board associate legend-em6p`, `ghostex board associate legend-fsl5`, `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- Laporan auto-journal (U1, U4): `docs/briefs/142-second-opinion-auto-journals.result.md` dan desain `docs/design/auto-journals.md` §10 di cabang `ws/aj-fix142` (`git show ws/aj-fix142:docs/design/auto-journals.md`). Consumer auto-journal sudah memarkir payout DP hangus; perbaikan ini mencegahnya di sumber.
- Penahan DP e7zj sudah di m1: `reservation-deposit-credit.ts`, `refundableBalance`, lock per intent DP.

## Scope
- Boleh diubah: modul refund (`payment-refund*.ts`, `payment-admin.service.ts` bagian refund), `pos-order.service.ts` (hanya pengambilan kunci dan waktu selesai), `reservation-lifecycle.ts`, jalur QR yang menyelesaikan order dengan DP, test terkait.
- Jangan disentuh: auto-journal consumer/amounts (milik thread auto-journal), `pos-shift.service.ts` (thread lain sedang mengubahnya), `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter DOIT.

## Bukti selesai
- Test reproduksi dulu (gagal sebelum fix): race dua urutan commit (cek `pg_locks` seperti test e7zj), refund DP hangus ditolak 409, tidak ada deadlock baru antar penulis.
- `LEGEND_TEST_FILES` daftar eksplisit (`src/test/*refund*`, `reservation*`, `pos-order*`, `qr-order*`, `payment-admin*`; dibuat dengan bash nullglob, jalankan lewat `bash -c`); laporkan jumlah file yang jalan dan lulus/gagal. tsc api/shared lewat `heavy`, eslint, prettier, kontrak node (`^ℹ pass`).
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Brief Codex `docs/briefs/168b-second-opinion-dp-intent-lock.md` (tidak di-commit, maks 800 baris non-test, tanpa temuan Claude).

## Sebelum melapor
Commit lokal di `ws/dp-intent-lock`. Pesan commit merujuk kartu. Jangan push, jangan merge. Migrasi baru (bila perlu): catat nomor dan `when`, merge train yang menomori ulang.

## Laporan
Lapor sekali setelah kedua kartu selesai. Isi: hasil, bukti (perintah, jumlah file test yang jalan, hasil), file berubah, commit SHA, urutan kunci akhir, risiko tersisa, yang dibutuhkan dari CTO.
