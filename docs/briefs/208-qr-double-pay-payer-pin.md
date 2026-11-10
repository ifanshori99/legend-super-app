# Brief: engineer — QR sale tidak boleh memakai intent bayar-ganda tanpa alokasi sebagai pembayar (legend-mks0q)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/qr-double-pay-payer-pin` dari ujung `milestone/m1` terbaru, worktree `.worktrees/qr-double-pay-payer-pin`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-mks0q` (P1, tingkat K: uang dan akuntansi). Temuan Codex lengkap: `docs/briefs/164-second-opinion-aj-qr-sale.result.md` (Run A) di folder utama.
Ringkas: order Rp100.000; kode A (superseded) settle dan dialokasikan Rp100.000; kode B settle sebelum event mana pun dikonsumsi, `payment.paid` B punya `allocatedIdr = 0` dan dana `double_payment` Rp100.000. Bila event B tiba dulu, `qr-order-consumers.ts:451-477` mem-pin B (baris ~467) sebagai pembayar sale, lalu meminta refund dana ganda B. Saat refund B selesai, guard `accounting-auto-journal-guards.ts:536-552`, `:568-590`, `:644-647` menghitung sale + payout Rp200.000 terhadap receipt B Rp100.000, sehingga payout sah diparkir permanen `POSTING_AMOUNTS_MISMATCH` dan receipt A tidak terpakai. Hasil akuntansi bergantung urutan event.
Perbaikan: pin hanya intent yang terbukti lewat fakta alokasi durable menutup `total - deposit_applied` pada payment link ini. Intent tanpa alokasi tetap mendapat refund dana gandanya, tetapi tidak menjadi pembayar sale; tunda fire ke event A atau tentukan pembayar teralokasi di bawah kunci order yang sudah ada. Arah perbaikan boleh kamu pilih sesudah membaca kode; catat alasannya.

## Kartu
`ghostex board associate legend-mks0q`, `bd update legend-mks0q --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `qr-order-consumers.ts` (jalur fire/pin), helper baca alokasi pembayaran, test. Bila memang perlu: query baca di `payment.service.ts`. Jangan: logika alokasi/penulisan `payment.paid` di `payment.service.ts`, guard jurnal (kecuali test), refund payout runner, `qr-order-pricing.ts` (cabang lain: legend-xx22n), skema/migrasi (bila ternyata perlu: berhenti dan lapor, nomor bebas 0160 when 1794239000000), `worker-main.ts`, auth.

## Bukti selesai
Test integrasi reproduksi gagal dulu di base: dua kode settle sebelum event dikonsumsi, kedua urutan pengiriman event (A dulu, B dulu), refund otomatis B selesai; hasil yang benar: satu sale, pembayar A, tidak ada payout diparkir, tidak ada sisa kredit deposit pelanggan. Test lama `qr-order-paid-event.test.ts` tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/208b-second-opinion-qr-double-pay-payer-pin.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, arah perbaikan dan alasannya, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
