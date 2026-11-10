# Brief: engineer (Sonnet) — adapter DOIT getPayment dan pemetaan status

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/doit-get-payment` dari `milestone/m1` (3517283b), worktree `.worktrees/doit-get-payment`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Migrasi hanya bila perlu: nomor dipesan `0189`, `when` 1794268000000.

## Tujuan
`legend-6g29` (P2, tingkat K uang). Audit 9 Nov (komentar kartu): verifier ada (`payment-doit-wire.ts` sekitar :353, header :36, tes `payment-doit.test.ts` sekitar :1498), refund adapter ada (`payment-doit.ts` sekitar :599). Kurang:
1. Adapter `getPayment` di `PaymentProvider` untuk DOIT, dengan pemetaan status DOIT ke `pending/paid/expired/failed/cancelled/refunded`. Status tak dikenal tidak pernah dipetakan ke `paid`; jadi galat jelas dan tercatat.
2. Konfirmasi format header `PayBridge-Signature` dan isi yang ditandatangani dari dokumen DOIT publik lewat subagent `web-fetch`. Bila dokumennya tidak publik atau tidak bisa dibaca, jangan menebak: biarkan verifier yang ada, tulis di laporan apa yang perlu dikonfirmasi founder dari DOIT.
3. Pakai `adapters/hmac.ts` yang ada; perbandingan tanda tangan waktu-konstan; dedupe per event id tetap "simpan dulu".

## Kartu
Awal: `ghostex board associate legend-6g29`, `bd update legend-6g29 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: adapter dan wire DOIT, `PaymentProvider` bila perlu, test. Jangan: refund flow, settlement (legend-cs7), kas-bank, UI. Kunci DOIT: hanya nama key dari `.env.example`, jangan baca `.env*`.

## Bukti selesai
- Test gagal-dulu: tiap status DOIT terpetakan benar; status tak dikenal tidak jadi `paid`; galat jaringan/timeout tidak mengubah status lokal; tanda tangan salah, kosong, atau dari body berbeda ditolak; event ganda tidak diproses dua kali.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck api lewat `heavy` sekali; eslint + prettier.
- Review (Q48, tingkat K): satu `architect`.
- Tulis brief Codex `docs/briefs/282b-second-opinion-doit.md`, jangan dijalankan.

## Laporan
Sekali di akhir: SHA, sumber dokumen DOIT yang dipakai (URL) atau yang perlu dikonfirmasi, migrasi (ada/tidak), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
