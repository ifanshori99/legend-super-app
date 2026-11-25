# Backfill piutang PPh 21 karyawan: latihan dan langkah staging/production (legend-wxvt9)

Staging belum ada. Latihan di bawah dijalankan di database sekali pakai lokal. Dry-run
di staging atau production BELUM dijalankan; bagian "Langkah" adalah resep yang harus
dijalankan operator.

## Apa yang dilakukan skrip

`apps/api/src/scripts/payroll-pph21-receivable-backfill.ts` memberi tiap karyawan yang
piutang PPh 21-nya lahir sebelum item terbuka 972 SATU item piutang
(`accounting_open_items`, kind `receivable`, counterparty `employee`, nomor dokumen
`PPH21-BACKFILL-<tanggal bayar>-<8 huruf id>`). Jumlah = saldo slip gaji terakhir dikurangi
item yang sudah ada. Tidak pernah lebih dari saldo slip. Satu transaksi per tenant, kunci
per badan hukum (sama dengan kunci run payroll), id item deterministik (UUIDv5) dengan
`ON CONFLICT DO NOTHING`. Ia hanya MENAMBAH baris item: tidak mengubah slip, run, jurnal,
atau pembayaran, dan tidak memotong atau membayar siapa pun.

Ragu = ditahan dan dilaporkan di `held`, tidak ada yang ditulis untuk karyawan itu:

| alasan                 | arti                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `payslip_unreadable`   | slip tak terbaca, atau pungutan lebih besar dari piutang yang dicatat       |
| `item_exceeds_balance` | item yang ada lebih besar dari saldo slip (tidak diturunkan oleh skrip ini) |
| `employee_missing`     | baris karyawan tidak ada                                                    |
| `id_taken`             | id item sudah dipakai (seharusnya mustahil)                                 |

## Hasil latihan (test `payroll-pph21-receivable-backfill.test.ts`, blok `legend-wxvt9`)

Database sekali pakai, migrasi penuh sampai head, dua badan hukum di tenant utama plus
tenant kedua. Data lama dibuat dengan service asli lalu diubah menjadi bentuk lama:
piutang positif (sebagian sudah dipungut), nol, karyawan keluar, run yang sudah di-reverse,
slip tanpa field carry (sebelum migrasi piutang), saldo negatif, slip rusak, item lama yang
lebih besar dari saldo, item lama sebagian. Perintah yang dijalankan persis perintah bead,
sebagai proses anak: `pnpm --filter @starter/api payroll:backfill-pph21-receivable --dry-run`.

| uji                         | bukti                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| dry-run                     | exit 0, laporan sama dengan run nyata; sidik jari baris (isi + `xmin`) item, pelunasan, slip, run, karyawan identik        |
| diputus di tengah (SIGKILL) | proses menunggu kunci badan hukum kedua setelah menulis yang pertama; setelah dibunuh, tidak ada baris tertulis (rollback) |
| run nyata                   | 7 item (6 + 1 tenant lain); jumlah item = selisih saldo; slip, run, pelunasan, karyawan tak berubah                        |
| ulang                       | tenant kedua `created: 0`; sidik jari identik (tidak ada UPDATE, `xmin` sama)                                              |
| dua proses bersamaan        | tepat satu yang membuat item; hasil akhir (id, jumlah) identik dengan run tunggal                                          |
| tidak dobel                 | run payroll berikutnya memungut sekali; saldo item = saldo slip, per karyawan                                              |
| tenant tidak bercampur      | item tenant kedua hanya milik karyawan dan badan hukum tenant itu                                                          |
| ditahan                     | saldo negatif dan slip rusak: `payslip_unreadable`; item 60 jt di atas saldo 40 jt: `item_exceeds_balance`, tidak diubah   |
| salah argumen / DB mati     | exit 2 (usage) / exit 1 (pesan tanpa data)                                                                                 |

### "Isian 0558"

Nomor 0558 sudah tidak ada (migrasi di-squash). Yang dimaksud brief 983 putaran 2 (R1) kini
`apps/api/drizzle/0454_payroll_overtime_correction_activations.sql`: tabel aktivasi koreksi lembur,
satu baris `now()` per tenant yang sudah punya run payroll. Diuji terhadap data lama (di
transaksi yang di-rollback): tenant dengan run mendapat tepat satu baris, tenant tanpa run
tidak, kali kedua tidak menambah, dan sesudah migrasi `payroll_runs` dan tabel baru tetap
FORCE RLS, role aplikasi hanya SELECT. Tidak ada temuan.

### Bug ditemukan dan diperbaiki

Perintah backfill hanya ada sebagai sumber `tsx`. Image produksi hanya berisi `dist/` (tanpa
pnpm, tsx, src), jadi dry-run gerbang rilis tidak bisa dijalankan di staging/VM. Perbaikan:
skrip jadi entry `tsup` (`dist/payroll-pph21-receivable-backfill.js`, wrapper `src/cli/` yang selalu
menjalankan; penjaga "apakah ini berkas entry" dihapus karena memberi exit 0 tanpa keluaran bila dipanggil
lewat path atau symlink, legend-1265 G1). Terverifikasi: `pnpm build` lalu `node dist/...js --foo` memberi
usage dan exit 2.

## Langkah staging, lalu production

Jalankan di staging dulu, lalu ulangi persis di production setelah hasil staging ditinjau.
Bekukan payroll (tidak ada run dibuat, disetujui, dikunci, atau di-reverse) dari dry-run sampai
verifikasi akhir selesai. Skrip menunggu kunci badan hukum bila ada run sedang dikunci, tetapi
pembekuan menjaga angka dry-run tetap sama dengan hasil nyata.

1. Cadangan. Jalankan di VM sebagai superuser/migrator di container postgres (role aplikasi DITOLAK
   membaca semua baris karena RLS), dengan `umask 077`, simpan salinan ke path host yang aman (bukan chat):
   `umask 077; docker compose --env-file <compose.env> -f deploy/single-vm/compose.yaml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -t accounting_open_items -t accounting_open_item_settlements' > <path host aman>/pra-backfill.sql`
   (atau snapshot VM). Salinan ini untuk bukti dan rujukan, bukan untuk dipulihkan (lihat "Cara mundur").
2. Prasyarat, sebelum pembekuan payroll dan dry-run: migrasi sudah sampai head dan image API memuat
   skrip (`ls dist/payroll-pph21-receivable-backfill.js`). Skrip memakai `APP_DATABASE_URL` (role aplikasi,
   kena RLS); bukan role migrasi. Selesaikan dulu semua reversal run payroll yang direncanakan: selama
   item backfill ada, reversal yang menaikkan atau memungut piutang karyawan itu ditolak, jadi
   reversal tidak bisa menyusul sesudah apply tanpa mundur.
3. Dry-run (tidak menulis apa pun):
   `docker compose --env-file <compose.env> -f deploy/single-vm/compose.yaml run --rm --no-deps -T api node dist/payroll-pph21-receivable-backfill.js --dry-run`
   Dari source checkout: `pnpm --filter @starter/api payroll:backfill-pph21-receivable --dry-run`.
   Simpan keluarannya ke berkas kerja aman (hanya hitungan dan id karyawan, tanpa nama atau jumlah per orang).
4. Baca hasil. Satu baris JSON per tenant: `created` (jumlah item yang akan dibuat), `createdIdr`
   (total rupiah), `held` (daftar `{legalEntityId, employeeId, reason}`), `entities` (per badan hukum:
   `legalEntityId`, `created`, `createdIdr`, `existingIdr` = sisa item piutang karyawan yang sudah ada),
   `dryRun: 1`. Baris terakhir `{"summary":{tenants,created,held}}`. Exit 0 berarti selesai, BUKAN berarti
   `held` kosong.
5. Ambang berhenti (putusan tim). STOP dan jangan jalankan tanpa `--dry-run` bila:
   - tidak ada baris `summary` (keluaran terpotong atau perintah mati diam-diam), atau exit bukan 0
     (1 = gagal, tidak ada yang tertulis untuk tenant yang gagal; 2 = salah argumen);
   - `summary.tenants` berbeda dari jumlah tenant (`SELECT count(*) FROM tenants`);
   - ada `held` berisi `employee_missing` atau `id_taken` (tidak boleh terjadi);
   - untuk SATU badan hukum, `existingIdr + createdIdr` lebih besar dari saldo akun 1204 (piutang PPh 21
     karyawan) di neraca saldo badan hukum itu per tanggal yang sama (cek manual; belum diuji otomatis).
     Selisih ke bawah (saldo 1204 lebih besar) tidak otomatis berhenti: accounting menilai sebabnya;
   - ada `payslip_unreadable` atau `item_exceeds_balance` yang belum dijelaskan tertulis oleh HR atau
     finance untuk tiap karyawannya (lanjut hanya bila tiap nama punya penjelasan; skrip tidak menulis
     apa pun untuk karyawan itu dan tidak menurunkan item yang ada);
6. Jalankan sungguhan, tanpa `--dry-run` (perintah sama tanpa flag). Bandingkan dengan dry-run: jumlah,
   rupiah, dan `held` harus sama. Bila berbeda: payroll tetap beku, lapor CTO, jangan diulang
   (jangan jalankan lagi, jangan mundur sendiri) sampai sebabnya jelas.
7. Verifikasi: jalankan dry-run lagi. Hasil benar: `created: 0` di semua tenant, `held` sama seperti
   langkah 4 (karyawan yang ditahan tetap ditahan). Cek di daftar piutang finance: saldo tiap
   karyawan = saldo slip terakhir. Baru sesudah ini payroll dibuka kembali.
8. Catat tanggal, perintah, hasil per tenant, dan keputusan atas `held` di `docs/PROGRESS.md`.

## Cara mundur

Item yang dibuat skrip bisa dikenali dari nomor dokumen `PPH21-BACKFILL-%`. Selama belum ada pelunasan
(belum ada run payroll terkunci sesudahnya yang memungut piutang itu), hapus item itu saja. Jalankan
sebagai role migrator (`BYPASSRLS`; role aplikasi ditolak), di dalam transaksi, dan
jangan `COMMIT` sebelum jumlah baris yang terhapus dicek:

```sql
BEGIN;
DELETE FROM accounting_open_items i
 WHERE i.tenant_id = '<tenant>' AND i.legal_entity_id = '<badan hukum>'
   AND i.kind = 'receivable' AND i.counterparty_type = 'employee'
   AND i.document_number LIKE 'PPH21-BACKFILL-%'
   AND i.settled_idr = 0
   AND NOT EXISTS (SELECT 1 FROM accounting_open_item_settlements s
                    WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id)
RETURNING i.id, i.original_idr;
-- Cocokkan: jumlah baris dan total original_idr <= hasil apply badan hukum itu (langkah 6).
-- Cocok: COMMIT;  Tidak cocok: ROLLBACK; dan berhenti.
```

Batasi per badan hukum (kolom `legal_entity_id`); skrip tidak mencetak id item, jadi pembatas lain adalah nomor dokumen dan `RETURNING` di atas. Item yang sudah ada pelunasan
(`settled_idr > 0` atau ada baris pelunasan, artinya payroll sudah memungut): JANGAN memulihkan
cadangan (itu menghapus pelunasan yang sah dan bisa membuat karyawan dipotong atau dibayar dobel).
Berhenti, hubungi CTO; perbaikannya maju, bukan mundur. Sesudah penghapusan yang sah, menjalankan
skrip lagi membuat id dan jumlah yang sama.
Catatan: selama item backfill ada, reversal run payroll yang menaikkan atau memungut piutang karyawan
itu ditolak (aturan sengaja, supaya daftar finance tetap sama dengan slip).
Tenant diproses satu per satu, satu transaksi masing-masing: bila skrip gagal di tengah, tenant sebelum
yang gagal SUDAH ter-commit. Reversal yang direncanakan sudah selesai di prasyarat (langkah 2); ulangi
skrip bila itu memang yang diputuskan CTO (idempoten).

## Belum diverifikasi

- Dry-run di staging atau production (belum ada staging); volume data nyata dan lamanya.
- Perintah `docker compose ... run --rm --no-deps -T api node dist/...` belum dijalankan di VM (hanya `node dist/...` lokal).
- Perbandingan dengan saldo akun 1204 (langkah 5) manual, belum ada kueri atau test.
- Pesan gagal skrip sengaja tanpa penyebab; untuk diagnosa lihat log database dan ketersediaan DB.
- Test memakai tenant seed bersama; di suite penuh paralel, skrip ikut memindai tenant itu (sama
  dengan `runBackfill` test lama).
