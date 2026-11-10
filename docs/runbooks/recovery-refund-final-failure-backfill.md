# Refund pemulihan yang gagal final: cek data dan rencana backfill (legend-pti5r)

Dokumen ini RENCANA. Belum dijalankan terhadap data nyata. Pelaksanaan
menunggu persetujuan CTO dan founder.

## Masalahnya

Refund pemulihan (ORD-09, `payment_refunds.requested_by = 'system:recovery'`)
yang gagal final seharusnya "membebaskan" penjualannya lagi: baris item boleh
dilaporkan ulang (`order_issues.refund_rejected_at`), jurnal refund dibalik
(event `order_issue.refund_reversal_requested`), dan, sejak legend-pti5r,
potongan promo yang sudah dicatat saat pengajuan pertama dikembalikan
(`promotion_order_applications.refunded_paid_idr` berkurang). Kode lama tidak
selalu melakukan semua itu, jadi uang tamu bisa tertahan: laporan ulang
menghitung "tidak ada yang tersisa" (`nothing_left`).

Gagal final berarti salah satu:

- alasan gagal selain `approval_expired` dan `approver_unauthorized`
  (`rejected`, `provider_declined`, `cap_exceeded`, `source_document`, kosong);
- sudah 3 refund gagal pada satu issue (`refile_limit`);
- tidak ada baris pengajuan pertama (`payment_admin_idempotency`, kunci
  `order-recovery-refund:<issueId>`), jadi tidak bisa diajukan ulang.

Syarat lain: issue `manual_refund`, tidak ada refund yang masih hidup (bukan
`failed`).

## Pemeriksaan (hanya baca)

Berkas: `apps/api/scripts/recovery-refund-final-failure-check.sql`. Isinya
`BEGIN READ ONLY ... ROLLBACK`, tidak menulis apa pun. Ujinya:
`apps/api/src/test/recovery-refund-final-failure-check-db.test.ts`.

Tiga query:

1. Gagal final yang belum diselesaikan: kolom `missing_stamp` (cap
   `refund_rejected_at` belum ada) dan/atau `missing_reversal` (ada event
   `order.refunded` untuk issue itu tetapi belum ada
   `order_issue.refund_reversal_requested`). Refund tagihan terbuka tidak punya
   `order.refunded`, jadi tidak ada jurnal yang perlu dibalik dan tidak
   ditandai.
2. Gagal final BUKAN `rejected` pada order promo yang pengajuan pertamanya
   mencatat `promoRecordedIdr` lebih dari 0 dan belum punya baris
   `promo_command_idempotency` berkunci
   `order-recovery-refund:<issueId>#promo-return`. Issue `rejected` sengaja
   tidak masuk: potongan promonya memang dibiarkan (legend-h1dyy).
3. Tinjauan manual: gagal final BUKAN `rejected` yang pengajuan pertamanya
   ditulis SEBELUM perubahan ini, yaitu respons punya `promoRecordedIdr` lebih
   dari 0 tetapi tidak punya `promoRefundedSubtotalIdr`. Kolom
   `payout_returned` menunjukkan apakah potongannya sudah kembali. Baris ini
   masuk daftar ini walau sudah punya baris `...#promo-return`.

Kolom hasil: `tenant_id`, `issue_id`, `order_id`, jumlah refund terakhir, alasan
gagal terakhir; query 2 juga `promo_recorded_idr`, `refunded_paid_idr`,
`application_status`; query 3 juga `promo_recorded_idr` dan `payout_returned`.

## Cara menjalankan

1. Ambil koneksi admin (peran yang melihat semua tenant: BYPASSRLS atau pemilik
   tabel) dari secret store. Jangan ditempel di chat, jangan dicetak ke log.
   Tanpa peran itu RLS menyembunyikan baris dan hasilnya kosong, yang
   menyesatkan.
2. Dari mesin operator yang punya repo:
   `psql "$ADMIN_DATABASE_URL" -f apps/api/scripts/recovery-refund-final-failure-check.sql > /tmp/cek-refund.txt`
   (simpan hasil di luar repo, hasilnya memuat id tenant dan jumlah uang).
3. Simpan jumlah baris per query dan per tenant untuk perbandingan nanti.

## Rencana backfill per kategori

Prinsip: pakai fungsi service yang sama dengan kode hidup, satu issue per
transaksi tenant, supaya hasilnya identik dengan kejadian baru dan aman
diulang. Jangan menulis SQL langsung ke `order_issues`, outbox, atau tabel
promo.

Untuk tiap baris (urut `tenant_id`, `issue_id`), dalam satu transaksi tenant
(`withTenant`, urutan kunci: intent, issue, promo, persis seperti kode
hidup):

1. Baca refund `failed` terakhir issue itu (`last_refund_id`), kunci intent-nya
   lebih dulu (`lockIntentsForFact`).
2. Panggil `refileRecoveryRefundAfterFailure(tx, context, failedRefund, now)`
   (`apps/api/src/services/order-recovery-refund.ts`). Satu panggilan
   menyelesaikan semua kategori di bawah.

| Kategori                               | Yang dilakukan panggilan itu                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `missing_stamp` (query 1)              | Mengisi `refund_rejected_at` (hanya jika masih kosong), sehingga baris item boleh dilaporkan ulang.                                                                                                          |
| `missing_reversal` (query 1)           | Menambah satu event `order_issue.refund_reversal_requested` (sekali per issue, hanya jika ada `order.refunded`).                                                                                             |
| Potongan promo belum kembali (query 2) | Memanggil `returnPartialRefundPayout` dengan kunci `order-recovery-refund:<issueId>#promo-return` dan `payoutIdr = promoRecordedIdr`. Kunci yang sama dengan kode hidup, jadi tidak pernah kembali dua kali. |
| `rejected`                             | Cap dan jurnal saja. Potongan promo tetap (keputusan legend-h1dyy).                                                                                                                                          |

`returnPartialRefundPayout` mengembalikan dua hal: `returnedIdr` (potongan
`refunded_paid_idr`) dan `returnedSubtotalIdr` (`refunded_subtotal_idr`). Input
`payoutIdr` dari `promoRecordedIdr` dan `refundedSubtotalIdr` dari
`promoRefundedSubtotalIdr` pada respons pengajuan pertama.

Baris lama (query 3): pengajuan pertamanya ditulis sebelum
`promoRefundedSubtotalIdr` disimpan, jadi hanya potongan (`refunded_paid_idr`)
yang bisa dikembalikan; `refunded_subtotal_idr` tidak ikut turun dan baris item
tetap dianggap sudah diproses (tetap dikecualikan dari laporan ulang). Baris
seperti ini tidak dibackfill otomatis: tinjau satu per satu secara manual
(CTO) dan koreksi lewat penyesuaian terpisah yang disetujui.

Bila kode hidup (kartu legend-pti5r) belum ter-deploy, jangan backfill: skrip
akan menandai ulang issue yang sama dan potongan promo tidak kembali.

Setelah potongan promo kembali, tamu belum otomatis mendapat uangnya: staf
melaporkan ulang baris itu sebagai issue baru. Itu langkah manusia yang
biasa; backfill hanya membuat laporan ulang tidak lagi `nothing_left`.

### Dry-run dulu

- Jalankan pemeriksaan di atas, bandingkan jumlahnya dengan perkiraan (harus
  kecil: hanya refund pemulihan yang gagal final sebelum perbaikan).
- Jalankan skrip backfill (belum ditulis, ditulis setelah rencana disetujui)
  dengan mode dry-run: tiap transaksi tenant di-`ROLLBACK` di akhir dan hanya
  mencetak apa yang akan terjadi per issue (cap, event, jumlah promo kembali).
- Uji dulu di staging dengan salinan data, bukan di production.

### Verifikasi

- Jalankan ulang pemeriksaan: query 1 dan 2 harus kosong (query 3 tetap berisi baris lama sampai ditinjau) untuk issue yang
  diproses (batch bertahap: kosong untuk batch itu).
- Per issue promo: `refunded_paid_idr` turun tepat sebesar `promo_recorded_idr`
  dan tidak pernah di bawah 0; `refunded_subtotal_idr` turun sebesar
  `promoRefundedSubtotalIdr` (hanya baris baru); baris `promo_command_idempotency` berkunci
  `...#promo-return` ada tepat satu.
- Per issue dengan `order.refunded`: tepat satu event
  `order_issue.refund_reversal_requested`, jurnal `aj:order-refund:<issueId>`
  punya pembalik.
- Jalankan ulang backfill pada issue yang sama: tidak ada perubahan (idempoten).

### Rollback

- Pemeriksaan tidak menulis apa pun, tidak perlu rollback.
- Backfill dijalankan per transaksi; transaksi yang gagal batal sendiri. Untuk
  batch yang sudah commit tidak ada tombol "urungkan" otomatis: cap, event
  pembalik, dan pengembalian promo tidak dihapus. Koreksi, bila perlu,
  dilakukan lewat penyesuaian terpisah yang disetujui CTO. Karena itu
  jalankan per tenant, mulai dari satu issue, lalu naikkan jumlahnya.
- Jangan menghapus baris `promo_command_idempotency` untuk "mengulang": itu
  membuka jalan pengembalian ganda.
