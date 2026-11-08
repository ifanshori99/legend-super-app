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
- Founder Q2: merge disetujui. `main` = `b0695ba` (merge --no-ff `ws/worker-transport`, tree identik `262d012` yang sudah hijau). Cabang + worktree worker dihapus.
- Founder Q3: mockup warna baru DISETUJUI.
- Thread "UI order pelanggan QR" (brief 09, `legend-2re1`): worktree `.worktrees/customer-order-ui`, cabang `ui/customer-order` (ux/customer-order-benchmark + main).
- Thread "Provisioning role DB first boot" (brief 10, `legend-zoqc`): worktree `.worktrees/db-role-provisioning`, cabang `ws/db-role-provisioning` dari main. Review: reviewer Opus tanpa blocker; second-opinion Codex 5 Tinggi (override identitas via query URL pg, override env file Compose, pg_default_acl, grant per kolom, rahasia bocor di error Compose). Fix: brief 12, engineer sama.
- Founder: metode bayar web = QRIS, VA, E-wallet, Kartu kredit/debit (+ bayar di kasir); kasir = semua + EDC. Diteruskan ke thread UI.
- Founder: minta lebih banyak agent paralel. Mulai 3 engineer: legend-6c0 shift (`ws/pos-shift`, brief 13), legend-93a struk (`ws/pos-receipt`, brief 14), legend-zinn+wg5t edge (`ws/edge-hardening`, brief 15). Migration bisa bentrok nomor: merge berurutan, generate ulang di cabang belakangan.

- Mockup POS kasir 21 layar (`design/mockups/pos/`, commit `3e09560`, brief 17) DISETUJUI founder Q10. Q7 DP lebih jadi saldo; Q8 blind count per pecahan; Q9 tutup hari manajer outlet, cutoff 04.00. Diteruskan ke thread shift dan fix pembayaran.
- zoqc: second-opinion putaran 2 = 3 Tinggi + 2 Sedang baru (PUBLIC baseline katalog, BOM/NBSP env, RLS tabel tenant tak diaudit, sequence ACL, docs ganti login queue). Fix: brief 18.
- Berikutnya saat slot Claude kosong: ui-engineer POS kasir dari `design/mockups/pos/`, engineer KDS legend-4d5, engineer EDC legend-m0k.

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
- Keputusan founder legend-j4ko (Q5/Q6) dikerjakan: template yang dilanjutkan setelah jeda melewati bulan selama jeda (mulai bulan berjalan); aksi operator `POST /api/accounting/recurring-journals/:id/skip-period` melewati bulan tutup buku (izin `accounting.journal.post`, audit, idempoten, migrasi 0065).
- Fix keamanan: efek persetujuan dari inbox mengecek ulang bahwa penyetuju memegang `accounting.journal.post` atas outlet header dan semua outlet baris; bila tidak, jurnal/template ditolak dan tidak ada yang diposting (`accounting-journal-approver.ts`).
- Perbaikan review K (2026-11-08): merge `main`; migration cabang 0063–0065 dibuat ulang jadi 0068 (tabel, FORCE RLS dilepas sementara saat validasi FK seperti 0065 main) dan 0069 (RLS), lulus test migrasi owner non-superuser. Jurnal manual yang rantainya sudah disetujui tapi postingnya ditolak (periode tutup, akun nonaktif) kini jadi `rejected` oleh sistem + audit, consumer tidak macet. Template berulang: `paused_at` (resume hanya melewati bulan setelah jeda, tunggakan tetap diposting, tiap bulan dilewati dicatat di `recurring_journal_runs` + audit); skip-period diizinkan bila posting ke bulan itu akan ditolak karena bulan sesudahnya tutup; `last_error`/`failed_at` untuk kegagalan job (dibersihkan saat sukses atau skip); penolakan sistem diaudit.

## legend-mjmm UI POS kasir (ui-engineer, cabang `ui/pos-kasir`)

- Selesai di worktree `.worktrees/pos-kasir-ui`: 21 layar dari mockup POS (Q10) di `/pos/bayar/$orderId` (QRIS, VA, e-wallet, kartu, tunai, EDC: pilih terminal, menunggu, status belum pasti dengan cek status dulu, berhasil, standalone dengan PIN supervisor; split tender; DP reservasi), `/pos/kode` (kode "Bayar di kasir"), `/pos/shift` (buka, aktif, pergerakan kas), `/pos/shift/tutup` (blind count per pecahan, Q8), `/pos/supervisor/shift/$shiftId` (persetujuan, `overrideId`), `/pos/tutup-hari` (manajer outlet, cutoff 04.00, Q9). Fitur `apps/web/src/features/ws04-pos-kasir/`, katalog `pos-kasir-*.ts`.
- Mode mock: mesin mock di browser (sessionStorage) + seed `?demo=`. Kontrak yang belum ada dicatat di `apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md` (EDC ECR, bank VA, e-wallet, kartu online, cari kode kasir, alokasi DP dan sisa DP jadi saldo, rencana split, settlement tutup hari, `closePosShiftInputSchema` masih `approvalRequestId`, persetujuan `edc_standalone`/`cash_shift_close`).
- Keputusan: modal awal Rp0 boleh tetapi perlu konfirmasi "Ya, laci kosong, buka shift" (sama dengan blind count); supervisor standalone tidak dipilih otomatis; persetujuan supervisor yang belum terpakai dipakai ulang bila pencatatan ditolak; mesin mock menolak pencatatan bila sisa tagihan berbeda dari nominal yang disetujui.
- Bukti: e2e mock `e2e/legend-mjmm-pos-kasir.mock.spec.ts` 32/32; screenshot 1280x800 di `docs/qa/pos-kasir/` (21, nama sama dengan mockup; banner sesi akses dukungan dari mock WS-01 disembunyikan hanya di screenshot). Gate setelah `node_modules` dipasang ulang di worktree (bukan symlink): `heavy pnpm check` (1393 test), `heavy pnpm build`, `pnpm format:check`, color, tenant-hardcode hijau. Review diff konteks segar + ui-auditor: temuan berat dibetulkan.
- Biaya sesi ui-engineer (transkrip 5d27428b, 1 compact, 40+ subagent): Opus utama 3694k, Sonnet 8474k, Haiku 223k; total sekitar 12391k unit biaya (sebelum gelombang audit terakhir).
- Sisa (saran): tab terpilih "Kas keluar" masih hitam pekat (ui-auditor: pakai gaya netral), chip, ikon dan perataan kecil vs mockup, header shell tanpa nama kasir.

## legend-apt EDC agent: perbaikan review K (engineer, cabang `ws/edc-framework`)

- `main` di-merge; migrasi EDC lama 0063/0064 dibuang, dibuat ulang dengan drizzle-kit dari 0067 jadi `0068_edc_transactions.sql` + `0069_edc_rls.sql`. 0068 melepas FORCE RLS di outlets, payment_edc_terminals, payment_intents selama validasi FK (pola 0065, migrator owner non-superuser).
- Agent: retry ditolak `EDC_NEEDS_RECONCILIATION` bila ada baris referensi itu yang ditandai rekonsiliasi (approved late), `EDC_STATUS_UNKNOWN` bila masih in-flight; `not_found` dipercaya hanya 15 menit sejak dispatch (`notFoundTrustWindowMs`); cancel lewat antrean terminal kecuali sale-nya sendiri sedang memegang kunci, ditolak saat terminal stuck; jawaban trace salah: inquiry tidak menulis hasil, sale/cancel simpan bukti + tandai rekonsiliasi; recoverPending hanya outlet yang baru diambil.
- Outbox: `edc_transaction.created/approved/declined/failed/cancelled/flagged` ditulis di transaksi yang sama (EDC-05). `settled` disisakan untuk settlement bank (EDC-06).
- Skema: kolom `type`, `mode`, `payment_intent_id`; `EdcProvider.void` + simulator; registry menolak simulator di production. Unique approved per referensi kini hanya `type = 'sale'`.
- Batch check (lanjutan CTO): `dispatch_batch_no` (migrasi 0070) = batch terakhir terminal saat dispatch; `not_found` hanya jadi `failed` bila batch di jawaban sama dengan batch saat dispatch, selain itu `unknown` + rekonsiliasi (bank tutup batch dalam 15 menit tidak lagi memicu tagih dobel). Kontrak `EdcProvider`: frame sale terkirim sinkron saat `sale()` dipanggil; `not_found` wajib membawa `batchNo`.
- Sisa risiko: sale pertama di terminal (batch belum diketahui) atau sesudah settlement malam selalu masuk rekonsiliasi manual bila hasilnya tak pasti; race kecil di `recoverInFlight` publik (baris yang dispatch di tick yang sama bisa sempat `unknown`, jawaban akhir tetap tercatat).

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

## legend-165 registri perangkat + mode latihan (engineer, cabang `ws/device-registry`)

- Selesai: tabel `devices` + `device_training_periods` (RLS tenant + outlet, trigger pencabutan final), migration `0068_closed_tiger_shark` (semula `0063_slim_nekra`, di-renumber di `ws/edge-registry-pull` setelah main; ditambah angkat FORCE RLS sementara untuk migrator pemilik tabel biasa). Route cloud `/api/devices` (daftar, daftarkan + token sekali tampil, terbit ulang token, cabut, mode latihan, heartbeat), edge `/api/edge/devices` (daftar, heartbeat), `/api/edge-sync/device-records` (ekspor replika untuk edge).
- Temuan keamanan ditutup: `deviceTenantCredential` dan `deviceReader` edge kini cek registri (perangkat aktif, tidak dicabut, tenant cocok, outlet node di edge, token tidak lebih tua dari terbit ulang terakhir). Token hanya diterbitkan service setelah cek registri.
- Review architect (2 medium, 3 low) dan reviewer (1 bug heartbeat domain ber-brand) dibetulkan.
- Lanjutan: `legend-2lp.7` P1 (jadwal tarik replika di runtime edge; sebelum itu semua token perangkat di edge ditolak), `legend-2lp.8` (cap `is_training` di pesanan POS + laporan), `legend-2lp.9` (panel ke `/api/devices/*`), `legend-2lp.10` (heartbeat edge ke cloud).

## legend-2lp.7 tarik registri perangkat berkala di edge (engineer, cabang `ws/edge-registry-pull`)

- Cabang ini = `ws/edge-hardening` + merge `ws/device-registry` + tarik berkala, supaya ketiganya di-merge sekali dengan aman.
- Tarik pertama saat boot (tidak memblokir boot), lalu tiap `EDGE_DEVICE_SYNC_INTERVAL_SECONDS` (default 60). Satu tarik sekaligus, backoff eksponensial sampai 5 menit saat cloud mati, berhenti bersih saat shutdown.
- Watermark disimpan di tabel baru `edge_pull_checkpoints` (migration `0069_hesitant_smiling_tiger`, RLS tenant + outlet), bukan dari replika: heartbeat edge menaikkan `updated_at` lokal.
- Gagal tarik: replika lama tetap dipakai, tidak ada akses device yang dibuka. Basi bila tarik sukses terakhir lebih tua dari `EDGE_DEVICE_SYNC_STALE_SECONDS` (default 900): log error, `deviceRegistry.stale` di `/api/edge/status` dan `/api/edge/health` (status HTTP health tidak berubah).
- Kontrak: `edgeStatusSchema.deviceRegistry` opsional (edge lama tidak mengirimnya). Lanjutan web: tampilkan status basi di panel edge dan isi mock `apps/web/src/features/ws02-edge/mock.ts`.
