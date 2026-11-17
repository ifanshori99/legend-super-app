# Second opinion rekonsiliasi 941

Tanggal: 17 November 2026. Brief: `docs/briefs/948-second-opinion-recon-941.md`.

Dasar: `c17c60df7`. Target beku: `44dc04cd91293a23e7c19be01532956fd17641cb`
(`origin/ghostex/rekonsiliasi-sisa-bank-dan-doit` saat pemeriksaan).
Semua rujukan berkas:baris di bawah mengacu pada target tersebut, bukan checkout utama.

Hasil: **1 P1 dan 1 P2**. Tidak ada temuan P0/P3 baru. Pemeriksaan dibagi ke tiga
subagent baca-saja (pembayaran, match bank, kebijakan/migrasi), puncak tiga berjalan
bersamaan; temuan diperiksa ulang oleh agent utama. Hanya laporan ini ditulis;
tidak ada perubahan implementasi, checkout/worktree baru, commit, push, atau merge.

## P1 — Bukti `refunded` hilang sehingga webhook `paid` lama masih melunasi tagihan

Lokasi perubahan: `apps/api/src/services/payment-doit-wire.ts:291`.

Skenario: DOIT sempat menerima Rp100.000 lalu mengembalikannya sebelum aplikasi
menerima webhook pembayaran pertama. Polling membaca `refunded`, tetapi mapper
mengubahnya menjadi `failed` tanpa nominal. Jalur polling menyimpan `failed`
sebelum kedaluwarsa (`apps/api/src/services/payment.service.ts:2042`) atau `expired`
sesudahnya (`apps/api/src/services/payment.service.ts:2007`). Tidak ada bukti
`refunded` yang disimpan untuk membedakannya dari kegagalan yang boleh dibayar
belakangan; `provider_answered_at` dan `provider_final_at` tidak membawa alasan itu.

Webhook asli `payment.paid` yang sah dan baru tiba kemudian memanggil
`confirmPayment` (`apps/api/src/services/payment-webhook.service.ts:783`). Di dalam
kunci, `applyConfirmation` membaca ulang intent, tetapi snapshot keputusan hanya
membawa status, metode, nominal, referensi, kedaluwarsa, dan flags
(`apps/api/src/services/payment.service.ts:2528`, `:2575`). Transisi
`failed/expired → paid` memang diizinkan bagi sumber gateway terverifikasi
(`packages/shared/src/payment/index.ts:65`, `:69`, `:83`;
`apps/api/src/services/payment-lifecycle.ts:130`). Karena evidence belum pernah
dicatat, jalur ini memasukkan evidence (`payment.service.ts:2697`), mengubah intent
menjadi `paid` (`:2729`), menambah `payment_links.paid_idr` (`:2753`), dan menerbitkan
`payment.paid` (`:2772`). Tagihan menjadi lunas dengan uang yang sudah dikembalikan
provider; outlet menanggung kekurangannya.

Ini adalah invariant `refunded` yang belum ditutup oleh perbaikan dalam diff,
bukan klaim bahwa seluruh jalur webhook tersebut baru ditambahkan. Di dasar,
webhook terlambat juga dapat melunasi intent yang masih `pending`. Brief secara
eksplisit meminta pemeriksaan `refunded` yang memicu pembayaran; pemetaan baru
ke status yang masih dapat dihidupkan kembali belum memenuhi invariant itu.

Perbaikan: simpan bukti pengembalian provider yang otoritatif dan bedakan dari
`failed/expired` yang masih mungkin menerima uang. Periksa bukti itu di dalam kunci
konfirmasi yang sama, termasuk jalur penolakan/parking, agar webhook lama tidak
menciptakan pelunasan, dana belum teralokasi, atau hak pengembalian baru. Jangan
mematikan seluruh penerimaan pembayaran terlambat untuk kegagalan biasa.

Usul test: pada intent VA tanpa evidence, poll jawaban `refunded`, lalu kirim
webhook asli `payment.paid` dengan signature sah dan referensi/nominal sama. Ulangi
untuk jawaban sebelum serta sesudah kedaluwarsa. Pastikan `paid_idr = 0`, tidak ada
event `payment.paid`, tidak ada evidence penerimaan baru/dana refundable, dan
pengiriman ulang tetap tidak menambah apa pun. Sertakan kontrol bahwa `failed`
biasa yang benar-benar dibayar kemudian tetap direkonsiliasi sekali.

## P2 — Hook stale membalik urutan kunci terhadap penutupan kasus `write_off`

Lokasi perubahan: `apps/api/src/services/accounting-bank-recon-stale.service.ts:53`
dan pemanggilnya `apps/api/src/services/accounting-journal.service.ts:1209`.

Skenario dua transaksi pada entitas dan jurnal J yang sama:

1. T1 menjalankan `write_off`, memperoleh entity advisory lock
   (`apps/api/src/services/accounting-bank-recon-cases.service.ts:625`), lalu
   memvalidasi J sebagai jurnal penyesuaian yang belum dibalik (`:655`).
2. Sebelum T1 menyimpan referensi jurnal, T2 menjalankan reversal J, memegang
   `FOR UPDATE` atas J (`apps/api/src/services/accounting-journal.service.ts:1096`),
   memasukkan reversal, lalu menunggu entity lock pada hook baru (`:1209`).
3. T1 mengisi `adjustmentJournalEntryId = J`
   (`apps/api/src/services/accounting-bank-recon-cases.service.ts:678`). FK
   `bank_reconciliation_cases_adjustment_fk`
   (`apps/api/drizzle/0191_cash_bank_recon.sql:92`) membutuhkan kunci `KEY SHARE`
   pada J dan menunggu `FOR UPDATE` milik T2.

T1 menunggu J milik T2; T2 menunggu entity lock milik T1. PostgreSQL harus
membatalkan salah satu transaksi dengan `40P01`. Tidak ada retry deadlock di kedua
jalur layanan tersebut. Hook mengambil entity lock sebelum memeriksa adanya
match, jadi reversal jurnal yang sama sekali tidak memiliki match bank pun
terkena. Ini berbeda dari urutan kunci DDL migrasi yang sudah dilacak pada
`legend-l29ln`.

Perbaikan: samakan urutan menjadi entity lock → journal row lock pada reversal
dan penulis rekonsiliasi terkait. Ambil ulang dan validasi jurnal setelah kunci
diperoleh; pertahankan serialisasi hook dengan match otomatis/manual.

Usul test: gunakan dua koneksi dan barrier setelah T1 memvalidasi jurnal write-off
serta setelah T2 memperoleh row lock J. Lanjutkan keduanya dan pastikan tidak ada
`40P01`; transaksi yang kehilangan syarat bisnis membaca ulang keadaan dan
menolak dengan konflik domain bila diperlukan. Pastikan reversal/case tidak
terduplikasi dan total debit/kredit tidak berubah oleh retry. Sertakan jurnal J
tanpa match bank untuk membuktikan cakupan lock baru.

## Cakupan lain dan pengecualian

- Kebijakan: SELECT/UPSERT memakai tenant terverifikasi, CHECK SQL membatasi
  `recon_case_due_days` ke 1–60, dan izin perubahan tetap
  `accounting.reconcile`. Tidak ditemukan jalur baru lintas tenant/peran.
- Migrasi 0432–0434: diperiksa statis bersama skema dan rantai snapshot. Pelepasan
  FORCE pada 0433/0434 dipulihkan sebelum transaksi migrator berakhir. Temuan FORCE
  lama tidak diulang; uji migrasi sebagai owner biasa pada database berisi data
  tetap berada pada tindak lanjut yang sudah diketahui (`legend-l29ln`).
- Balapan match otomatis/manual dengan hook: entity lock menserialkan insert
  match dan penandaan stale; tidak ditemukan interleaving gagal baru dalam dua
  jalur itu. Temuan P2 di atas berasal dari penulis kasus yang memakai FK jurnal.
- Kandidat kebocoran outlet melalui outlet header jurnal ditolak setelah
  memeriksa `requireTenantPermission` pada route kasus; assignment outlet/brand
  tidak dapat mengakses endpoint tersebut.
- Polling setelah 24 jam dan satu approver Owner/Finance Manager diterima sesuai
  brief, sehingga bukan temuan.

## Verifikasi dan batas bukti

- Membaca diff dan jalur pemanggilan dari objek Git target, tanpa checkout.
- Reproduksi fungsi murni lewat `heavy node`: source mapper, tabel transisi,
  `canTransitionPayment`, dan `decidePaymentConfirmation` diambil langsung dengan
  `git show 44dc04cd9:<path>`, tipe dihapus memakai `node:module`, lalu dieksekusi
  dalam VM. Untuk referensi sama, VA Rp100.000, dan sumber `verified_webhook`,
  hasilnya:

  ```text
  providerStatus=refunded storedStatus=failed decision=settle nextStatus=paid unallocatedIdr=0
  providerStatus=refunded storedStatus=expired decision=settle nextStatus=paid unallocatedIdr=0
  ```

  Run tersebut exit 0. Ini membuktikan keputusan fungsi pada target, bukan
  reproduksi HTTP/database end to end. Percobaan awal terhenti sebelum logika
  karena paket `typescript` tidak tersedia dari root; percobaan final memakai
  penghapus tipe bawaan Node dan tidak memasang dependensi.

- P2 diverifikasi melalui urutan SQL dan FK secara statis; belum direproduksi
  dengan dua transaksi PostgreSQL.
- Tidak menjalankan suite test API, migrasi pada database, typecheck, build, atau
  e2e. Hasil test implementer di `docs/PROGRESS.md` tidak diklaim sebagai run ini.
- Laporan diperiksa dengan Prettier, pemeriksaan whitespace, serta kecocokan
  20 rujukan utama terhadap target Git sebelum handoff. Perintah
  `pnpm exec prettier` terhenti karena shim root menunjuk paket yang hilang;
  formatter Prettier 3.9.6 yang sudah ada di `node_modules/.pnpm` dijalankan
  langsung untuk `--write` dan `--check`, tanpa memasang dependensi.
