# Refund pemulihan yang gagal final: cek data dan rencana backfill (legend-pti5r)

Dokumen ini RENCANA. Belum dijalankan terhadap data nyata. Pelaksanaan
menunggu persetujuan CTO dan founder.

## Masalahnya

Refund pemulihan (ORD-09, `payment_refunds.requested_by = 'system:recovery'`)
yang gagal final seharusnya "membebaskan" penjualannya lagi: baris item boleh
dilaporkan ulang (`order_issues.refund_rejected_at`), jurnal refund dibalik
(event `order_issue.refund_reversal_requested`). Kode lama tidak selalu
melakukan itu, jadi uang tamu bisa tertahan: laporan ulang menghitung "tidak
ada yang tersisa" (`nothing_left`).

Sejak legend-pti5r ledger promo TIDAK disentuh saat gagal final: potongan
(`promotion_order_applications.refunded_paid_idr` dan `refunded_subtotal_idr`)
tetap tersimpan untuk baris itu, jadi tidak ada issue lain yang bisa
menyerapnya. Aturan ulang-lapor: bila baris item YANG SAMA dilaporkan ulang
setelah gagal final selain `rejected`, issue baru mengajukan ulang jumlah dan
rincian refund yang gagal (tanpa hitung promo baru dan tanpa mencatat potongan
lagi), dibatasi sisa ruang intent saat itu. Issue `rejected` tetap
`nothing_left` (legend-h1dyy).

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

Satu query:

1. Gagal final yang belum diselesaikan: kolom `missing_stamp` (cap
   `refund_rejected_at` belum ada) dan/atau `missing_reversal` (ada event
   `order.refunded` untuk issue itu tetapi belum ada
   `order_issue.refund_reversal_requested`). Refund tagihan terbuka tidak punya
   `order.refunded`, jadi tidak ada jurnal yang perlu dibalik dan tidak
   ditandai.

Ledger promo tidak diperiksa dan tidak perlu backfill: sengaja tidak disentuh,
dan laporan ulang memutar ulang refund yang gagal (lihat aturan di atas).

Kolom hasil: `tenant_id`, `issue_id`, `order_id`, `last_refund_id`, jumlah
refund terakhir, alasan gagal terakhir, `failed_count`, `missing_stamp`,
`missing_reversal`.

## Cara menjalankan

1. Ambil koneksi admin dari secret store. Jangan ditempel di chat, jangan
   dicetak ke log. Peran WAJIB superuser atau punya BYPASSRLS. Pemilik tabel
   TIDAK cukup: tabel memakai FORCE ROW LEVEL SECURITY, yang berlaku juga untuk
   pemilik, jadi koneksi pemilik tanpa BYPASSRLS akan melihat nol baris. Untuk
   mencegah hasil kosong yang menyesatkan itu, skrip gagal eksplisit di
   pernyataan pertama (error `recovery refund check needs a superuser or
BYPASSRLS role`, SQLSTATE 42501) bila peran bukan superuser dan tidak
   BYPASSRLS. Error itu berarti ganti koneksi, bukan berarti datanya bersih.
2. Dari mesin operator yang punya repo:
   `psql -v ON_ERROR_STOP=1 "$ADMIN_DATABASE_URL" -f apps/api/scripts/recovery-refund-final-failure-check.sql > /tmp/cek-refund.txt`
   (simpan hasil di luar repo, hasilnya memuat id tenant dan jumlah uang).
   `ON_ERROR_STOP=1` menghentikan skrip begitu pengaman gagal.
3. Simpan jumlah baris per tenant untuk perbandingan nanti.

## Rencana backfill per kategori

Prinsip: pakai fungsi service yang sama dengan kode hidup, satu issue per
transaksi tenant, supaya hasilnya identik dengan kejadian baru dan aman
diulang. Jangan menulis SQL langsung ke `order_issues`, outbox, atau tabel
promo.

Untuk tiap baris (urut `tenant_id`, `issue_id`), dalam satu transaksi tenant
(`withTenant`, kunci intent lebih dulu, persis seperti kode hidup):

1. Baca refund `failed` terakhir issue itu (`last_refund_id`), kunci intent-nya
   lebih dulu (`lockIntentsForFact`).
2. Panggil `refileRecoveryRefundAfterFailure(tx, context, failedRefund, now)`
   (`apps/api/src/services/order-recovery-refund.ts`). Satu panggilan
   menyelesaikan semua kategori di bawah.

`refileRecoveryRefundAfterFailure` aman dipanggil berulang untuk refund gagal
yang sama: panggilan kedua dan seterusnya tidak menambah audit (audit ditulis
sekali per id refund atau issue, pola `auditOnce`), tidak menambah event, dan
tidak mengubah cap `refund_rejected_at`. Jadi backfill yang terputus atau
diulang tidak menggandakan catatan.

| Kategori                     | Yang dilakukan panggilan itu                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `missing_stamp` (query 1)    | Mengisi `refund_rejected_at` (hanya jika masih kosong), sehingga baris item boleh dilaporkan ulang.              |
| `missing_reversal` (query 1) | Menambah satu event `order_issue.refund_reversal_requested` (sekali per issue, hanya jika ada `order.refunded`). |
| `rejected`                   | Cap dan jurnal saja. Laporan ulang tetap `nothing_left` (keputusan legend-h1dyy).                                |

Tidak ada backfill promo. Ledger promo sengaja tidak disentuh saat gagal final:
`refunded_paid_idr` dan `refunded_subtotal_idr` tetap menahan potongan baris
itu. Setelah cap terisi, staf melaporkan ulang baris item yang SAMA sebagai
issue baru; issue baru memutar ulang jumlah dan rincian refund yang gagal
(dari payload `order.refunded` issue lama), tanpa hitung promo dan tanpa
`recordPartialRefundPayout`, dibatasi sisa ruang intent. Itu langkah manusia
yang biasa; backfill hanya membuat laporan ulang tidak lagi `nothing_left`.
Item lain pada order yang sama dihitung dari baris miliknya sendiri.

Bila kode hidup (kartu legend-pti5r) belum ter-deploy, jangan backfill: skrip
akan menandai ulang issue yang sama.

### Dry-run dulu

- Jalankan pemeriksaan di atas, bandingkan jumlahnya dengan perkiraan (harus
  kecil: hanya refund pemulihan yang gagal final sebelum perbaikan).
- Jalankan skrip backfill (belum ditulis, ditulis setelah rencana disetujui)
  dengan mode dry-run: tiap transaksi tenant di-`ROLLBACK` di akhir dan hanya
  mencetak apa yang akan terjadi per issue (cap dan event).
- Uji dulu di staging dengan salinan data, bukan di production.

### Verifikasi

- Jalankan ulang pemeriksaan: query 1 harus kosong untuk issue yang diproses
  (batch bertahap: kosong untuk batch itu).
- Per issue dengan `order.refunded`: tepat satu event
  `order_issue.refund_reversal_requested`, jurnal `aj:order-refund:<issueId>`
  punya pembalik.
- Ledger promo (`refunded_paid_idr`, `refunded_subtotal_idr`) tidak berubah
  oleh backfill.
- Jalankan ulang backfill pada issue yang sama: tidak ada perubahan (idempoten).

### Rollback

- Pemeriksaan tidak menulis apa pun, tidak perlu rollback.
- Backfill dijalankan per transaksi; transaksi yang gagal batal sendiri. Untuk
  batch yang sudah commit tidak ada tombol "urungkan" otomatis: cap dan event
  pembalik tidak dihapus. Koreksi, bila perlu,
  dilakukan lewat penyesuaian terpisah yang disetujui CTO. Karena itu
  jalankan per tenant, mulai dari satu issue, lalu naikkan jumlahnya.
