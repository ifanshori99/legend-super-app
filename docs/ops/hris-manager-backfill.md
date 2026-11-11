# Backfill `employees.manager_id` (legend-qhqf8, 512)

Commit 4b7eb37a membatasi supervisor dan outlet manager ke bawahan langsung:
karyawan hanya terlihat bila `employees.manager_id` = id karyawan si atasan
(`reachedEmployeeCondition` di `apps/api/src/services/hris-access.ts`).
Karyawan aktif dengan `manager_id` kosong tidak terlihat oleh mereka. GM (scope
brand) tetap melihat semua karyawan brand dan tidak berubah (Q41, ae5c3e82).

Skrip `apps/api/src/db/backfill-employee-managers.ts` mengisi `manager_id`
karyawan aktif dengan outlet manager aktif di outlet asalnya. Tidak ada migrasi
skema. Data ini data pribadi (tingkat K), jadi skrip hanya mengubah baris yang
sudah disetujui orang.

**JANGAN dijalankan oleh agent ke production atau staging.** Agent boleh
menjalankannya hanya terhadap database lokal sekali pakai untuk test. Production
dan staging dijalankan manusia (operator) setelah gerbang founder.

**Layar HR belum punya edit atasan.** `managerId` hanya diisi saat karyawan
dibuat (`hris-employee.service.ts:708`). Karena itu daftar manual tidak bisa
diselesaikan di layar HR dan rollback tidak punya layar undo. Keduanya butuh
tugas engineer lewat CTO (lihat bagian 2 dan Rollback).

## Apa yang dicek dan diubah

Hanya karyawan berstatus `active` yang diperiksa. Tiga masalah:

| Issue                  | Arti                                                               | Tindakan skrip                           |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `no_manager`           | `manager_id` kosong                                                | auto bila ada tepat satu usulan aman     |
| `manager_inactive`     | atasan tidak aktif (resign, suspend, dll.) atau barisnya tidak ada | auto bila ada tepat satu usulan aman     |
| `manager_cross_outlet` | outlet asal atasan berbeda dari outlet asal karyawan               | selalu manual, tidak pernah diubah skrip |

Usulan = satu-satunya outlet manager aktif di outlet asal karyawan (assignment
`outlet_manager` yang berlaku sekarang, karyawannya aktif dan outlet asalnya
outlet itu). Hasilnya manual (bukan auto) bila salah satu alasan ini berlaku:

- `cross_outlet_needs_review`: untuk `manager_cross_outlet`. Supervisor area bisa
  sah lintas outlet, manusia yang memutuskan.
- `holds_manager_role`: karyawan memegang role selain role junior, misalnya
  outlet manager, supervisor, GM, HR, finance, atau role custom. Orang seperti
  ini tidak pernah di-auto-assign, supaya senior tidak jadi bawahan outlet
  manager. Role junior yang diizinkan: `cashier`, `waiter`, `barista_cook`,
  `facility_attendant`, `kitchen_lead`, `warehouse`, `employee`.
- `no_outlet_manager`: tidak ada outlet manager aktif di outlet itu.
- `ambiguous_outlet_manager`: lebih dari satu.
- `would_cycle`: usulan atau atasannya berantai kembali ke karyawan itu, atau
  karyawan itu sendiri satu-satunya outlet manager (tidak jadi atasan dirinya).

Skrip hanya menulis `manager_id` dan `updated_at`. Status dan kolom lain tidak
disentuh. Tiap perubahan menulis satu baris audit.

## Siapa yang menyetujui

| Daftar                       | Penyetuju                                            |
| ---------------------------- | ---------------------------------------------------- |
| Daftar auto                  | HR lead, ditinjau bersama outlet manager tiap outlet |
| Daftar manual                | HR lead dan GM brand menentukan atasan per baris     |
| Tugas engineer daftar manual | CTO (tugas terpisah, bukan bagian skrip ini)         |
| Menjalankan di staging/prod  | Gerbang founder (lewat CTO), lalu operator manusia   |

## Urutan sebelum rollout

1. Deploy build yang memuat skrip ke environment tujuan.
2. Dry-run per environment (bagian 1). Tidak menulis apa pun.
3. HR dan outlet manager meninjau daftar auto dan daftar manual (bagian 2).
4. HR lead menyimpan id yang disetujui ke berkas `approved-ids.txt` (bagian 3).
5. Apply dengan `--ids` (bagian 4).
6. Dry-run ulang. Hasil yang benar: 0 auto (bagian 5).
7. Keputusan atasan untuk daftar manual diserahkan ke CTO sebagai tugas engineer
   terpisah (bagian 2). Tidak bisa dikerjakan di layar HR.
8. Baru setelah itu scope 502 (batas ke bawahan langsung) dibuka untuk
   supervisor dan outlet manager.

Jangan lompat ke langkah 8 sebelum langkah 6 dan 7 selesai: karyawan tanpa atasan
hilang dari layar supervisor dan outlet manager. Bila langkah 7 belum selesai,
keputusan membuka scope 502 dengan sisa manual dibawa ke founder lewat CTO.

## 1. Dry-run (baca saja)

Dari `apps/api`, koneksi database lewat `MIGRATION_DATABASE_URL_FILE` (path ke
berkas berisi URL, jangan cetak URL). Pilih salah satu, bukan keduanya:

```bash
pnpm --filter @starter/api db:backfill-employee-managers --dry-run
# satu tenant saja (opsional):
pnpm --filter @starter/api db:backfill-employee-managers --dry-run --tenant <tenant-uuid>
```

`--dry-run` adalah default. Transaksi per tenant, hanya baca, tidak ada update
dan tidak ada audit. Log tidak memuat nama lengkap atau user id.

Log ditulis per tenant begitu tenant itu selesai: satu baris ringkasan, lalu
baris auto tenant itu. Setelah semua tenant: baris `Total`, daftar manual (CSV
dengan kolom `tenant_id`), dan daftar id untuk ditinjau.

Contoh keluaran, dua tenant (id palsu):

```text
tenant=11111111-1111-4111-8111-111111111111 findings=6 auto=3 manual=3 no_manager=4 manager_inactive=1 manager_cross_outlet=1
tenant=11111111-1111-4111-8111-111111111111 employee=aaaaaaaa-0000-4000-8000-000000000001 no=EMP-0101 outlet=bbbbbbbb-0000-4000-8000-000000000001 issue=no_manager current=- proposed=cccccccc-0000-4000-8000-000000000001
tenant=11111111-1111-4111-8111-111111111111 employee=aaaaaaaa-0000-4000-8000-000000000002 no=EMP-0102 outlet=bbbbbbbb-0000-4000-8000-000000000001 issue=no_manager current=- proposed=cccccccc-0000-4000-8000-000000000001
tenant=11111111-1111-4111-8111-111111111111 employee=aaaaaaaa-0000-4000-8000-000000000003 no=EMP-0110 outlet=bbbbbbbb-0000-4000-8000-000000000002 issue=manager_inactive current=dddddddd-0000-4000-8000-000000000009 proposed=cccccccc-0000-4000-8000-000000000002
tenant=22222222-2222-4222-8222-222222222222 findings=0 auto=0 manual=0 no_manager=0 manager_inactive=0 manager_cross_outlet=0
Total: findings=6 auto=3 manual=3
# MANUAL LIST (csv: tenant_id,employee_id,employee_no,outlet_id,issue,reason)
11111111-1111-4111-8111-111111111111,aaaaaaaa-0000-4000-8000-000000000004,EMP-0120,bbbbbbbb-0000-4000-8000-000000000003,no_manager,no_outlet_manager
11111111-1111-4111-8111-111111111111,aaaaaaaa-0000-4000-8000-000000000005,EMP-0130,bbbbbbbb-0000-4000-8000-000000000001,manager_cross_outlet,cross_outlet_needs_review
11111111-1111-4111-8111-111111111111,aaaaaaaa-0000-4000-8000-000000000006,EMP-0140,bbbbbbbb-0000-4000-8000-000000000001,no_manager,holds_manager_role
# Ids for review (save approved to a file for --ids)
aaaaaaaa-0000-4000-8000-000000000001
aaaaaaaa-0000-4000-8000-000000000002
aaaaaaaa-0000-4000-8000-000000000003
Dry-run: nothing written. Add --apply --ids <file>.
```

Simpan keluaran ke berkas kerja yang aman (berisi nomor karyawan dan id, bukan
nama). Jangan tempel ke chat atau tiket publik.

## 2. Tinjauan

- Daftar auto: HR lead dan outlet manager memeriksa tiap baris: apakah
  `proposed` memang atasan langsung karyawan itu. Baris yang ragu dihapus dari
  daftar id (tidak ikut apply).
- Daftar manual: HR lead dan GM brand menentukan atasan per baris, termasuk
  baris `manager_cross_outlet` (bisa jadi sah, misalnya supervisor area) dan
  baris `holds_manager_role` (atasannya bukan otomatis outlet manager). Kolom
  `tenant_id` menunjukkan tenant tiap baris. Hasil keputusan dicatat per baris.

Daftar manual **tidak bisa diselesaikan di layar HR**: tidak ada edit atasan di
sana (`managerId` hanya diisi saat karyawan dibuat,
`hris-employee.service.ts:708`). Mengisi atasan untuk daftar ini butuh tugas
engineer terpisah yang disetujui CTO. Jangan membuat alat sendiri dan jangan
menulis SQL ad hoc ke production. Serahkan daftar manual beserta keputusan HR
dan GM ke CTO.

## 3. Berkas id yang disetujui

Satu uuid per baris, baris `#` adalah komentar. Contoh `approved-ids.txt`:

```text
# disetujui HR lead, ditinjau outlet manager, 2026-11-12
aaaaaaaa-0000-4000-8000-000000000001
aaaaaaaa-0000-4000-8000-000000000002
```

Hanya id di berkas ini yang boleh berubah. Id manual atau id di luar berkas
tidak pernah disentuh. Id di berkas boleh dari beberapa tenant.

## 4. Apply

Hanya setelah gerbang founder dan oleh operator manusia:

```bash
pnpm --filter @starter/api db:backfill-employee-managers --apply --ids approved-ids.txt
```

- Tanpa `--ids`, skrip menolak (exit 2) dan tidak menulis apa pun.
- Satu transaksi per tenant. Tiap tenant di-commit dan dicatat di log begitu
  selesai, dengan baris `tenant=<id> updated=<n> skipped=<n>`.
- Bila satu tenant (misalnya tenant B) gagal, skrip berhenti dengan exit 1.
  Tenant sebelumnya (tenant A) tetap ter-commit dan sudah tercatat di log.
  Tenant sesudahnya tidak disentuh. Lihat baris `updated=` terakhir di log untuk
  tahu tenant mana yang sudah selesai, perbaiki penyebab kesalahan, lalu jalankan
  ulang dengan berkas id yang sama (aman diulang, lihat di bawah).
- Di dalam transaksi, baris dikunci (`FOR UPDATE`) dan klasifikasi dihitung
  ulang. Baris yang berubah sejak dry-run (sudah punya atasan lain, atasan
  berbeda dari usulan, tidak lagi aktif) dilewati dan dicatat sebagai skipped.
- Tiap update menulis satu baris `audit_logs` dengan action
  `hris.employee_manager_backfill`, reason `legend-qhqf8 512 backfill manager_id`,
  actor `system`, dan nilai sebelum/sesudah `managerId`.
- Di akhir: baris `Total`, baris `SKIPPED employee=<id>` untuk tiap id yang
  dilewati, daftar manual, dan baris `Updated <n> employee(s)` dengan jumlah
  audit yang ditulis.
- Kode keluar: 0 selesai, 1 dibatalkan karena kesalahan, 2 salah pemakaian.

Skrip aman diulang: run kedua tidak menemukan baris auto yang sama, jadi tidak
mengubah dan tidak menulis audit. Id yang sudah terisi pada run sebelumnya
muncul sebagai `SKIPPED` di run berikutnya, itu normal.

## 5. Verifikasi

```bash
pnpm --filter @starter/api db:backfill-employee-managers --dry-run
```

Hasil yang diharapkan: `auto=0` di baris ringkasan tiap tenant dan di baris
`Total`. Sisa temuan hanya daftar manual (dan baris auto yang sengaja tidak
disetujui). Bila `auto` masih ada, periksa apakah itu baris yang dilewati
(skipped) saat apply, lalu tinjau ulang.

Cek cepat di layar: login sebagai outlet manager sampel, pastikan karyawan
outlet itu muncul. Login sebagai GM brand, pastikan semua karyawan brand tetap
terlihat.

## Rollback

Skrip tidak punya mode undo, dan **tidak ada layar atau tombol undo**: layar HR
tidak bisa mengubah atasan karyawan yang sudah ada (`managerId` hanya diisi saat
karyawan dibuat, `hris-employee.service.ts:708`). Pengembalian dilakukan
engineer lewat CTO, dari nilai sebelum di audit. Setiap baris audit
`hris.employee_manager_backfill` menyimpan nilai `managerId` sebelum perubahan.
Prosedur:

1. Operator memberi tahu CTO: tenant, rentang waktu apply, dan karyawan yang
   perlu dikembalikan (atau semuanya).
2. CTO menugaskan engineer. Engineer membaca baris audit action
   `hris.employee_manager_backfill` untuk tenant dan rentang waktu itu, dan
   mengambil nilai "sebelum" `managerId` tiap karyawan.
3. Engineer mengembalikan `managerId` ke nilai itu lewat tugas yang disetujui
   CTO. Bila nilai sebelumnya kosong, dikosongkan. Jangan menulis SQL ad hoc ke
   production tanpa persetujuan CTO.
4. Pengembalian dicatat dengan audit sendiri beserta alasannya.

Efek mengembalikan atasan menjadi kosong: karyawan itu hilang lagi dari layar
supervisor dan outlet manager, jadi lakukan sebelum scope 502 dibuka.

## Batasan

- Hanya karyawan `active`. Karyawan `onboarding`, `suspended`, `resigned`,
  `terminated` tidak diperiksa.
- Skrip tidak membaca atau mencetak nama lengkap dan user id.
- Skrip tidak menyentuh baris `manual`, apa pun isi `--ids`.
- Skrip tidak mengubah GM atau akses scope brand.
- Skrip tidak menyelesaikan daftar manual dan tidak punya undo. Keduanya butuh
  tugas engineer lewat CTO.
