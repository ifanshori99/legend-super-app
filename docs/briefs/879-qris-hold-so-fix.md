# Brief: engineer — perbaikan second opinion QRIS hold (5 P1 + 2 P2) di atas m1

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo dan cabang
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri. Cabang baru `fix/qris-hold-so-879` dari `origin/ghostex/qris-hold-dp-c2-c3` (6cfe64ba6, sudah memuat C1 `ghostex/775-qris-hold-c1`). Langkah pertama: `git merge origin/milestone/m1` ke cabang itu (bukan sebaliknya), selesaikan konflik, nomori ulang migrasi C1/C2/C3 (0368-0370) supaya menyambung setelah migrasi terakhir m1, rechain journal/snapshot drizzle, jangan ubah migrasi yang sudah ada di m1. Migrasi baru: rentang sementara 0621-0625. Tambahkan guard hold 409 `QRIS_HOLD_ACTIVE` ke penulisan orders di `qr-order.service.ts` m1 setelah 5dcc1cfd9 (kartu `legend-5ailc`), plus test rollback item/stok/promo saat trigger menolak.

## Tujuan
Tutup semua temuan di `docs/qa/second-opinion-qris-hold.md` (di folder utama repo; baca seluruhnya: berkas:baris, skenario, usul test). Aturan founder: jangan sampai rugi. Tiap perbaikan dibuktikan test bahwa pelanggan tidak membayar lebih dari tagihan, outlet tidak menerima kurang, dan tidak ada refund ganda.

## Kartu
`legend-zff37` (release di luar kunci), `legend-ota0l` (migrasi QR lama), `legend-w0ows` (EDC vs QR), `legend-9ho2v` (provider-proof DP), `legend-kf104` (QR tamu order utuh), `legend-eqeu7` (P2 poll split deadlock + pairing throttle), `legend-5ailc`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat lapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan>"`.

## Keputusan CTO (sudah diambil, jangan ditanyakan ulang; semua aturan yang paling membatasi)
- zff37: release (manual dan job) membaca ulang status intent dan evidence teralokasi di bawah kunci order/hold/link/intent dalam transaksi release. Ada bukti bayar: release ditolak dan pembayaran diselesaikan (capture sekali), tidak ada tender void atau refund.
- ota0l: migrasi/cutover membuat hold untuk setiap kode penyedia yang mungkin masih tertagih, termasuk tender void lokal, link/split expired lokal, dan intent superseded, selama belum ada bukti penyedia bahwa kode itu mati. Tagihan itu tertahan sampai job cek penyedia membuktikan mati/bayar. Jangan lewati riwayat ambigu diam-diam.
- w0ows: agent EDC dan route tender EDC menolak memulai sale kartu bila tagihan punya hold QR aktif (kasir batalkan QR dulu, terbukti mati). Balapan yang tetap lolos (QR masuk saat sale kartu sedang diproses) mengikuti founder Q7: kartu menang, QR direfund penuh. Satu pembukuan, urutan kunci tanpa siklus.
- 9ho2v: provider-proof memeriksa semua intent penyedia tagihan/reservasi yang mungkin memegang uang (pending, expired lokal, superseded), fail closed bila status belum terbukti; pembatalan reservasi menunggu rekonsiliasi sebelum memutuskan refund/forfeit.
- kf104: QR tamu order utuh memakai aturan yang sama dengan split: satu kode tertagih per tagihan, kode pengganti hanya terbit setelah kode lama terbukti mati di penyedia.
- eqeu7: I/O penyedia dan settlement dipindah keluar transaksi yang memegang kunci order, lalu baca ulang di bawah kunci. Pairing: serialisasi per outlet (advisory lock transaksi) sebelum hitung/insert, batas 5 per terminal dan 20 per outlet tetap.

## Scope
- Boleh: service/route/migrasi pembayaran QRIS, hold, provider-proof, qr-order, customer-display, reservation-lifecycle, EDC agent (`apps/api/src/edge/edc/`), test API terkait, kontrak `packages/shared` bila kode error baru.
- Jangan: UI (`apps/web`), modul payout/loyalty/refund lain di luar jalur QRIS, cabang lain. Jangan merge ke m1 atau main, jangan deploy.
- FORCE RLS: tanpa FK `NOT VALID`.

## Pembagian paralel (giliran pertama, setelah merge m1 selesai dan test QH/QD hijau di cabang hasil merge)
- Explore (4): zff37+9ho2v, ota0l, w0ows, kf104+eqeu7.
- test-writer (2): test gagal-dulu sesuai "Test" di laporan, dijalankan di cabang hasil merge; catat nama test merah dan sebabnya.
- implementer: satu per kartu; berkas tumpang tindih (`pos-qris-hold.ts`, `qr-order-payment.ts`, `payment.service.ts`) dikerjakan berurutan atau dibagi per fungsi.
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- Test baru merah sebelum fix, hijau sesudah; ditambah QH-*, QD-*, CREDIT-HOLD, SESSION-MOVE, EDC, reservasi, registry migrasi data: `LEGEND_TEST_FILES="<daftar>" heavy pnpm test`.
- Migrasi diuji dari database m1 (bukan dari kosong saja).
- Pra-gate AGENTS.md: prettier, eslint, `pnpm db:generate` kosong, `heavy pnpm --filter @starter/api typecheck` (dan web bila shared berubah).
- Review: satu subagent `architect` effort xhigh (uang + migrasi) atas diff; temuan nyata dibetulkan sebelum lapor.
- Commit dan push tanpa force. Laporan: cabang, SHA, migrasi (nomor), test merah→hijau, angka subagent (total, puncak, pemegang heavy).
- Lapor sekali saat selesai; tunggu job latar dengan Monitor di giliran yang sama.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua sekaligus, sekali lagi. Gagal ketiga: lapor ke CTO dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
