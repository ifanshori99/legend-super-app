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
skrip jadi entry `tsup` (`dist/payroll-pph21-receivable-backfill.js`) dan penjaga "apakah ini
berkas entry" menerima `.js`. Terverifikasi: `pnpm build` lalu `node dist/...js --foo` memberi
usage dan exit 2.

## Langkah staging, lalu production

Jalankan di staging dulu, lalu ulangi persis di production setelah hasil staging ditinjau.
Jangan jalankan saat ada run payroll sedang dikunci (skrip menunggu kunci badan hukum itu).

1. Cadangan. Salin dua tabel (baca-saja, di VM):
   `pg_dump --data-only -t accounting_open_items -t accounting_open_item_settlements <db> > pra-backfill.sql`
   (atau snapshot VM). Simpan di tempat aman, jangan ke chat.
2. Prasyarat: migrasi sudah sampai head dan build memuat skrip (`ls dist/payroll-pph21-receivable-backfill.js`
   di image API). Skrip memakai `APP_DATABASE_URL` (role aplikasi, kena RLS); bukan role migrasi.
3. Dry-run (tidak menulis apa pun):
   `docker compose --env-file <compose.env> -f deploy/single-vm/compose.yaml exec api node dist/payroll-pph21-receivable-backfill.js --dry-run`
   Dari source checkout: `pnpm --filter @starter/api payroll:backfill-pph21-receivable --dry-run`.
   Simpan keluarannya ke berkas kerja aman (hanya hitungan dan id karyawan, tanpa nama atau jumlah per orang).
4. Baca hasil. Satu baris JSON per tenant: `created` (jumlah item yang akan dibuat), `createdIdr`
   (total rupiah), `held` (daftar `{legalEntityId, employeeId, reason}`), `dryRun: 1`. Baris terakhir
   `{"summary":{tenants,created,held}}`. Exit 0 berarti selesai, BUKAN berarti `held` kosong.
5. Ambang berhenti (usulan tim, putuskan bersama CTO): STOP dan jangan jalankan tanpa `--dry-run` bila
   - exit bukan 0 (1 = gagal, tidak ada yang tertulis untuk tenant yang gagal; 2 = salah argumen);
   - ada `held` berisi `employee_missing` atau `id_taken` (tidak boleh terjadi);
   - ada `payslip_unreadable`: periksa tiap karyawan (slip rusak atau pungutan melebihi piutang); sampai
     jelas, karyawan itu tidak mendapat item dan tidak ada yang dipotong atau dibayar;
   - ada `item_exceeds_balance`: finance menentukan mana yang benar; skrip tidak menurunkan item;
   - `createdIdr` satu tenant lebih besar dari saldo akun 1204 (piutang PPh 21 karyawan) di neraca saldo
     tenant itu per tanggal yang sama (cek manual; belum diuji otomatis);
   - jumlah `created` jauh dari jumlah karyawan yang memang punya piutang menurut payroll (selisih besar).
6. Jalankan sungguhan, tanpa `--dry-run` (perintah sama tanpa flag). Boleh diulang kapan pun.
7. Verifikasi: jalankan dry-run lagi. Hasil benar: `created: 0` di semua tenant, `held` sama seperti
   langkah 4 (karyawan yang ditahan tetap ditahan). Cek di daftar piutang finance: saldo tiap
   karyawan = saldo slip terakhir.
8. Catat tanggal, perintah, hasil per tenant, dan keputusan atas `held` di `docs/PROGRESS.md`.

## Cara mundur

Item yang dibuat skrip bisa dikenali dari nomor dokumen `PPH21-BACKFILL-%`. Selama belum ada pelunasan
(belum ada run payroll terkunci sesudahnya yang memungut piutang itu), hapus item itu saja (diuji di
test, tenant lain tidak tersentuh):

```sql
DELETE FROM accounting_open_items i
 WHERE i.tenant_id = '<tenant>' AND i.kind = 'receivable'
   AND i.counterparty_type = 'employee'
   AND i.document_number LIKE 'PPH21-BACKFILL-%'
   AND i.settled_idr = 0
   AND NOT EXISTS (SELECT 1 FROM accounting_open_item_settlements s
                    WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id);
```

Jalankan sebagai role pemilik tabel, di transaksi, cek jumlah baris dulu. Item yang sudah ada pelunasan
(`settled_idr > 0` atau ada baris pelunasan) jangan dihapus: pulihkan dari cadangan langkah 1 lewat
CTO dan founder. Sesudah dihapus, menjalankan skrip lagi membuat id dan jumlah yang sama.
Catatan: selama item backfill ada, reversal run payroll yang menaikkan atau memungut piutang karyawan
itu ditolak (aturan sengaja, supaya daftar finance tetap sama dengan slip).

## Belum diverifikasi

- Dry-run di staging atau production (belum ada staging); volume data nyata dan lamanya.
- Perintah `docker compose ... exec api node dist/...` belum dijalankan di VM (hanya `node dist/...` lokal).
- Perbandingan dengan saldo akun 1204 (langkah 5) manual, belum ada kueri atau test.
- Pesan gagal skrip sengaja tanpa penyebab; untuk diagnosa lihat log database dan ketersediaan DB.
- Test memakai tenant seed bersama; di suite penuh paralel, skrip ikut memindai tenant itu (sama
  dengan `runBackfill` test lama).
