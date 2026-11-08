# PROGRESS — Legend Super App

Diperbarui 2026-11-08 oleh CTO (coordinator Ghostex, sesi "CTO legend"). Founder menghentikan semua kerja untuk dilanjutkan di sesi baru.

## Sudah

- Benchmark order pelanggan ESB + Richeese vs Legend: `design/benchmark/REPORT.md` (14 celah), `design/REFERENCES.md`. Cabang `ux/customer-order-benchmark`.
- Keputusan founder:
  - Q3: "Bayar di kasir" boleh (kode ke kasir, pesanan masuk dapur setelah kasir terima uang).
  - Q4: arah A (katalog foto).
  - Q5: jumlah tamu inline di bar atas menu, wajib sebelum item pertama, tanpa jendela sambutan.
  - Founder minta gaya liquid glass; menilai versi lama "AI slop dan jadul".
- Mockup final arah A + liquid glass: `design/mockups/final-a-*.png` (9 mobile + 1 desktop), README berisi usulan perubahan `DESIGN.md`. Commit `b52b03b`.
- legend-18qw (worker event transport, gap replay, adapter notifikasi Brevo): commit `b22d549` di `ws/worker-transport` (worktree `.worktrees/worker-transport`). pnpm check hijau. Bead sudah di-close engineer.
- Review legend-18qw: reviewer Claude (tanpa blocker) + second-opinion Codex (2 major). Semua temuan: `docs/briefs/06-fix-review-worker-transport.md`.

## Sedang

- (kosong selain thread di bawah)

## Sesi CTO baru (2026-11-08, lanjutan)

- SELESAI fix review legend-18qw (brief 07): `ws/worker-transport` = `262d012` (amend WIP). 9 fix + 3 temuan reviewer subagent dibetulkan. `heavy pnpm check` hijau (1192 test), build hijau, format/color/tenant-hardcode lulus. `legend-3a0y` ditutup. Bead baru: `legend-7h5s` (edge tanpa cloud-sync tenant-wide), `legend-z649` (healthcheck worker), `legend-k1np` P1 (cek backfill sequence sebelum deploy), `legend-j75w` P2 (alert terthrottle auth Brevo). Sisa risiko: dedup Brevo belum dites ke Brevo asli (tunggu `legend-wwuc`); at-least-once bila retry >30 menit. Biaya sesi engineer: ~933k (Opus 668k, Haiku 151k, Sonnet 114k).
- SELESAI riset warna (brief 08, Codex): `design/COLOR-RESEARCH.md`, 10 `final-a-*` ditimpa, palet CTA #A83A17 / canvas #FAF6F0 / tinta #2B211B, upsell croissant opsional, 87 pasangan kontras lolos AA. Commit `13606fe` (sebagian artefak ikut tersapu commit CTO `b76fc75`; riwayat dibiarkan). Dikirim ke founder sebagai Q3 (setuju / ubah).
- Menunggu founder: Q2 merge `ws/worker-transport` ke `main`; Q3 persetujuan mockup.

## legend-2re1 UI order pelanggan (ui-engineer, cabang `ui/customer-order`)

- Selesai di worktree `.worktrees/customer-order-ui`: semua layar `/t/$token/*` dibangun ulang ke tema QR (`[data-surface="qr"]`, palet Q6, kaca hanya di lapisan mengambang, maks 2 blur), jumlah tamu inline (Q5), "Bayar di kasir" (Q3) via route `/t/$token/kasir/$orderId`, satu saran pendamping. `DESIGN.md` §9 baru.
- Bukti: screenshot 390/1440 + axe di `docs/qa/customer-order/` (0 serious/critical, tanpa overflow, fallback kontras tinggi / tanpa transparansi = 0 blur). Review diff + ui-auditor + finish-reviewer: temuan dibetulkan.
- Pra-merge (founder setuju UI, Q11): checkout dengan kode promo/voucher kini menampilkan rincian dan total dari quote tanpa kode (yang benar-benar dibayar) dan menahan tombol bayar sampai quote itu ada (pesan + "Coba lagi" bila gagal), test baru `e2e/legend-2re1.mock.spec.ts`; lebar hero h16t per viewport (36 px di bawah lg karena padding sheet 16 px, 52 px dari lg); `QrFrameNotices` dipindah ke `glass/qr-frame-notices.tsx`, madge tanpa siklus; `design/**` diabaikan eslint dan prettier. Gate: `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, color, tenant-hardcode hijau; e2e `/t/` 35/35 (spec baru diulang 3x stabil).
- Koreksi founder 2026-11-08: metode bayar = QRIS, Virtual Account, E-wallet, Kartu kredit/debit, Bayar di kasir. VA dan Kartu ditambahkan di checkout + layar `/t/$token/bayar/$orderId?metode=va|kartu` (instruksi VA dengan nomor contoh, alih ke halaman kartu penyedia tanpa form kartu). Kontrak meja hanya menerima QRIS/e-wallet, jadi VA/Kartu hanya jalan di mode mock; dengan API asli barisnya nonaktif dan layarnya menampilkan "belum tersedia".
- Bukti akhir: `heavy pnpm build` lulus; e2e mock `/t/` 33/33; suite mock penuh 739 lulus, 4 gagal di luar `/t/` (d6g5, er32, oye8, uq2; diff cabang ini di luar QR hanya tambahan); capture 52 state, 0 serious/critical kecuali 1 artefak posisi scroll (target-size link tertutup bar atas saat capture), tanpa overflow, maks 2 blur.
- Biaya sesi ui-engineer (transkrip fe7d1815, 07:57–09:41 UTC, 2 compact, 19 subagent): Opus utama 6128k, Sonnet 5723k, Opus subagent 257k, Haiku 114k; total 12223k unit biaya.
- Kebutuhan kontrak (belum dikerjakan): metode bayar kasir / kode bayar eksplisit + POS terima pembayaran order tertahan; ubah pax sesi; foto cover outlet; patch opsi baris keranjang; kode promo/voucher ikut `placeOrder`; metode guest `va` dan `card` (nomor VA + channel + kedaluwarsa, URL halaman kartu penyedia di `guestPaymentSchema`).

## legend-vmyg jurnal manual & berulang (engineer, cabang `ws/journals`)

- Selesai di worktree `.worktrees/journals`: tabel `manual_journals`, `recurring_journals`, `recurring_journal_runs` (migrasi 0063 + RLS FORCE 0064), service manual (draf, ajukan, setujui, tolak, tarik, batal), service berulang + job `runDueRecurringJournals` (satu transaksi per bulan, kunci unik template+periode), route `/api/accounting/manual-journals` dan `/recurring-journals`, consumer `approval.resolved`, job di `worker-main.ts`.
- Persetujuan lewat `approval_requests` (aksi `manual_journal`); pembuat tidak bisa menyetujui (service, state machine, check constraint DB). Ledger hanya ditulis setelah disetujui.
- Titik cek periode tunggal: `apps/api/src/services/accounting-journal-period-gate.ts` (disambung ke kunci `ws/fiscal-close-lock` saat merge).
- Kontrak: `manualJournalSchema` dilonggarkan, penolakan sistem (rantai kedaluwarsa) boleh tanpa `decidedBy`.
- Keputusan terbuka: template berulang yang tertahan di bulan tertutup berhenti sampai periode dibuka lagi atau template diakhiri; jeda (pause) mengejar bulan yang terlewat saat dilanjutkan.

## Keputusan founder Q6 (mockup final): UBAH DULU

- Catatan founder apa adanya: "Coba riset warna termasuk warna button secara psikologis yang mendorong pembelian serta membuat orang memesan banyak".
- Langkah: riset psikologi warna untuk F&B order (warna CTA/tombol, warna yang mendorong nafsu makan dan nilai pesanan lebih besar, bukti dari sumber kredibel, bedakan mitos vs bukti, tetap lolos kontras WCAG), tulis `design/COLOR-RESEARCH.md`, lalu designer (Codex) ulang `final-a-*` dengan palet baru, review founder lagi. Pola upsell/menambah pesanan (rekomendasi "tambah minuman", bundling) boleh diusulkan bersama.

## Langkah berikut

1. (selesai) fix brief 06.
2. (selesai, menunggu founder Q3) riset warna + ulang mockup.
3. Setelah mockup disetujui: ui-engineer bangun UI order pelanggan dari `final-a-*`, update `DESIGN.md` sesuai usulan README mockup. Jangan sentuh area worker.
4. Merge `ws/worker-transport` dan `ux/customer-order-benchmark` ke `main`: menunggu gerbang founder.
5. Penghalang rilis lain (HANDOFF.md §7): legend-zoqc, legend-91i (layar ke API asli), POS FE, dsb.

## Catatan teknis

- Coordinator Ghostex dijalankan di folder `legend super app` (bukan repo git): `start-thread --worktree` gagal. Buat worktree manual di `legend/.worktrees/<nama>` + `.claude/settings.local.json` pematik claude-mem, tulis path di brief.
- Brief tim: `docs/briefs/01..06`.

## Vendor (gelombang ini)

- Claude: benchmark, engineer, reviewer (3 tugas). Codex: designer (2 putaran), second-opinion (3 tugas).
