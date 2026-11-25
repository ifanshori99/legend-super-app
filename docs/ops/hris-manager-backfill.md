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

**Daftar manual dan rollback dikerjakan di layar.** Buka Profil karyawan, di
baris Atasan tekan tombol **Ubah atasan** (legend-f4uvg). Perubahan lewat jalur
ini divalidasi dan dicatat di jejak audit dengan action
`hris.employee_manager_change` (lihat bagian 2 dan Rollback).

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

| Daftar                      | Penyetuju                                            |
| --------------------------- | ---------------------------------------------------- |
| Daftar auto                 | HR lead, ditinjau bersama outlet manager tiap outlet |
| Daftar manual               | HR lead dan GM brand menentukan atasan per baris     |
| Menjalankan di staging/prod | Gerbang founder (lewat CTO), lalu operator manusia   |

## Urutan sebelum rollout

1. Deploy build yang memuat skrip ke environment tujuan.
2. Dry-run per environment dan simpan manifest CSV baru (bagian 1). Database
   tidak berubah.
3. HR dan outlet manager meninjau daftar auto dan daftar manual (bagian 2).
4. HR lead meninjau tuple karyawan, atasan lama, dan usulan atasan; hapus baris
   yang tidak disetujui dari manifest `approved-managers.csv` (bagian 3).
5. Apply dengan manifest yang ditinjau itu, `--manifest` (bagian 4).
6. Dry-run ulang. Hasil yang benar: 0 auto (bagian 5).
7. HR atau GM brand mengisi atasan untuk daftar manual lewat Profil karyawan >
   Ubah atasan, satu karyawan per baris (bagian 2).
8. Baru setelah itu scope 502 (batas ke bawahan langsung) dibuka untuk
   supervisor dan outlet manager.

Jangan lompat ke langkah 8 sebelum langkah 6 dan 7 selesai: karyawan tanpa atasan
hilang dari layar supervisor dan outlet manager. Dry-run ulang (bagian 5)
menunjukkan sisa baris manual yang belum diisi.

## 1. Dry-run (baca saja)

Dari `apps/api`, koneksi database lewat `MIGRATION_DATABASE_URL_FILE` (path ke
berkas berisi URL, jangan cetak URL). Pilih salah satu, bukan keduanya:

Di VM produksi tidak ada pnpm: ganti `pnpm --filter @starter/api db:backfill-employee-managers`
dengan `docker compose ... --profile migration run --rm --no-deps -T -v <folder absolut di host>:/manifest migrate node dist/backfill-employee-managers.js`
dan tulis manifest ke `/manifest/<nama>.csv` (folder host harus bisa ditulis user `node` di
container; tanpa `-v`, container sekali pakai membuang manifest). Di VM, service `migrate` sudah
memakai `MIGRATION_DATABASE_URL` dari `migrator.env`; tidak perlu `_FILE`. Argumen salah keluar
bukan 0 dengan petunjuk.

```bash
pnpm --filter @starter/api db:backfill-employee-managers --dry-run --manifest review-managers.csv
# satu tenant saja (opsional):
pnpm --filter @starter/api db:backfill-employee-managers --dry-run --manifest review-tenant.csv --tenant <tenant-uuid>
```

`--dry-run` adalah default. Transaksi per tenant, hanya baca, tidak ada update
dan tidak ada audit. `--manifest` menulis berkas CSV baru dengan izin `0600`;
berkas yang sudah ada tidak ditimpa, supaya persetujuan lama tidak tergantikan
oleh perhitungan baru. Log tidak memuat nama lengkap atau user id. `--ids`
masih tersedia sebagai filter dry-run opsional, bukan bukti persetujuan apply.

Log ditulis per tenant begitu tenant itu selesai: satu baris ringkasan, lalu
baris auto tenant itu. Setelah semua tenant: baris `Total`, daftar manual (CSV
dengan kolom `tenant_id`), dan manifest usulan untuk ditinjau.

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
# Manifest for HR review (--manifest CSV)
employee_id,current_manager_id,proposed_manager_id
aaaaaaaa-0000-4000-8000-000000000001,,cccccccc-0000-4000-8000-000000000001
aaaaaaaa-0000-4000-8000-000000000002,,cccccccc-0000-4000-8000-000000000001
aaaaaaaa-0000-4000-8000-000000000003,dddddddd-0000-4000-8000-000000000009,cccccccc-0000-4000-8000-000000000002
Dry-run: nothing written to the database. Apply the reviewed --manifest <file>.
Review manifest written; remove unapproved rows before --apply.
```

Simpan keluaran ke berkas kerja yang aman (berisi nomor karyawan dan id, bukan
nama). Jangan tempel ke chat atau tiket publik.

## 2. Tinjauan

- Daftar auto: HR lead dan outlet manager memeriksa tiap baris: apakah
  `proposed` memang atasan langsung karyawan itu. Baris yang ragu dihapus dari
  manifest (tidak ikut apply). Nilai atasan lama dan usulan yang dipertahankan
  harus tetap sama dengan hasil dry-run yang ditinjau.
- Daftar manual: HR lead dan GM brand menentukan atasan per baris, termasuk
  baris `manager_cross_outlet` (bisa jadi sah, misalnya supervisor area) dan
  baris `holds_manager_role` (atasannya bukan otomatis outlet manager). Kolom
  `tenant_id` menunjukkan tenant tiap baris. Hasil keputusan dicatat per baris.

Daftar manual diselesaikan per baris di layar, oleh HR (role `hr`) atau GM brand.
GM hanya bisa untuk karyawan brand-nya sendiri. Penjagaan ada di dua lapis:

- Rute API menghentikan akun yang tidak memegang `hr.employee.manage` maupun
  `hr.attendance.manage` dengan `PERMISSION_DENIED`. Supervisor dan kasir
  biasanya berhenti di sini. Layar hanya menampilkan pesan umum
  ("Atasan tidak dapat disimpan. Coba lagi sebentar lagi."), bukan pesan peran,
  dan tombol **Ubah atasan** tidak muncul bagi mereka.
- Tombol **Ubah atasan** mengikuti `canChangeManager` dari detail karyawan:
  HR harus punya izin kelola di outlet asal karyawan, atau GM punya cakupan
  brand/tenant yang mencakup outlet itu. Tombol tidak muncul di profil sendiri
  maupun profil pada outlet yang hanya boleh dilihat. API PATCH tetap
  memeriksa izin itu saat menyimpan.

Dua aturan lain: karyawan harus terlihat oleh pemanggil (bila tidak, 404), dan
tidak seorang pun bisa mengubah atasannya sendiri (403 dengan pesan yang sama;
minta HR atau GM lain).

1. Buka Profil karyawan untuk karyawan di baris daftar manual (cari lewat nomor
   karyawan).
2. Di baris Atasan tekan **Ubah atasan**.
3. Pilih atasan di daftar "Atasan langsung" (format "nama (nomor)", hanya
   karyawan aktif), atau **Tanpa atasan** untuk mengosongkan.
4. Isi "Alasan (opsional)", maksimal 200 karakter, misalnya "keputusan HR dan GM,
   daftar manual backfill".
5. Tekan **Simpan atasan**. Tombol tidak aktif bila pilihan sama dengan atasan
   sekarang. Muncul pesan "Atasan diperbarui".

Tiap simpan menulis satu baris audit `hris.employee_manager_change` dengan nilai
sebelum/sesudah `managerId` dan alasan. Jangan menulis SQL ad hoc ke production.

Pesan galat yang bisa muncul:

| Pesan                                                                                          | Arti dan tindakan                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Atasan ini berada di bawah karyawan yang bersangkutan, sehingga membentuk lingkaran. ..."     | Atasan yang dipilih ada di bawah karyawan ini (rantai atasan kembali). Pilih atasan lain.                                 |
| "Peran atasan lebih rendah dari karyawan ini. ..."                                             | Karyawan memegang role non-junior, atasannya hanya role junior. Pilih supervisor atau lebih tinggi.                       |
| "Atasan yang dipilih tidak aktif atau tidak ditemukan. ..."                                    | `MANAGER_NOT_ELIGIBLE`: atasan bukan karyawan aktif, atau di luar karyawan yang bisa Anda lihat. Pilih orang lain.        |
| "Peran Anda tidak boleh mengubah atasan karyawan ini."                                         | 403: bukan HR atau GM brand yang mencakup outlet asal karyawan, atau mengubah atasan diri sendiri. Minta HR atau GM lain. |
| "Atasan tidak dapat disimpan. Coba lagi sebentar lagi."                                        | Galat lain, termasuk `PERMISSION_DENIED` dari rute (tanpa izin HR/GM). Cek peran dulu; bila berulang, lapor ke CTO.       |
| "Atasan tidak bisa diubah: pilihan sama dengan sebelumnya, atau memilih karyawan itu sendiri." | Pilihan tidak berubah atau memilih dirinya sendiri. Pilih orang lain.                                                     |

Memilih **Tanpa atasan** tidak pernah ditolak karena aturan role. Dua perubahan
atasan di tenant yang sama diproses bergantian, jadi dua orang yang saling
menjadikan atasan tidak bisa sama-sama berhasil.

## 3. Manifest yang disetujui

Berkas CSV yang dihasilkan dry-run memuat tiga kolom berikut. Nilai kosong di
`current_manager_id` berarti `NULL`; usulan atasan wajib UUID. Contoh
`approved-managers.csv` setelah baris yang belum disetujui dihapus:

```csv
# disetujui HR lead, ditinjau outlet manager, 2026-11-12
employee_id,current_manager_id,proposed_manager_id
aaaaaaaa-0000-4000-8000-000000000001,,cccccccc-0000-4000-8000-000000000001
aaaaaaaa-0000-4000-8000-000000000003,dddddddd-0000-4000-8000-000000000009,cccccccc-0000-4000-8000-000000000002
```

Hanya tuple di berkas ini yang boleh diterapkan. Jangan membuat persetujuan dari
daftar id saja, dan jangan mengganti usulan setelah ditinjau. Baris duplikat
ditolak. Baris kosong dan komentar `#` diabaikan. Manifest boleh mencakup
beberapa tenant; baris manual atau id di luar manifest tidak pernah disentuh.

## 4. Apply

Hanya setelah gerbang founder dan oleh operator manusia:

```bash
pnpm --filter @starter/api db:backfill-employee-managers --apply --manifest approved-managers.csv
```

- Tanpa `--manifest`, skrip menolak (exit 2) dan tidak menulis apa pun. Apply
  dengan `--ids` juga ditolak; persetujuan harus menyertakan kedua nilai atasan.
- Satu transaksi per tenant. Tiap tenant di-commit dan dicatat di log begitu
  selesai, dengan baris `tenant=<id> updated=<n> skipped=<n>`.
- Bila satu tenant (misalnya tenant B) gagal, skrip berhenti dengan exit 1.
  Tenant sebelumnya (tenant A) tetap ter-commit dan sudah tercatat di log.
  Tenant sesudahnya tidak disentuh. Lihat baris `updated=` terakhir di log untuk
  tahu tenant mana yang sudah selesai, perbaiki penyebab kesalahan, lalu jalankan
  ulang dengan manifest yang sama (aman diulang, lihat di bawah).
- Di dalam transaksi, karyawan dikunci (`FOR UPDATE`), calon atasan dikunci
  (`FOR SHARE`), lalu status, tenant, role, outlet, dan klasifikasi dibaca ulang.
  Kunci calon atasan ditahan sampai commit, sehingga offboarding tidak bisa
  mengubah statusnya di tengah penulisan. Nilai atasan lama dan usulan harus
  sama persis dengan manifest yang sudah ditinjau HR. Baris yang berubah sejak
  dry-run (sudah punya atasan lain, usulan berubah, tidak lagi aktif atau layak)
  dilewati dan dicatat sebagai skipped, tanpa otomatis memilih pengganti baru.
  Baris yang hilang atau di luar `--tenant` juga dilaporkan sebagai skipped.
- Log apply memakai `approved_current` dan `approved_proposed` untuk nilai yang
  ditinjau HR, bukan usulan baru yang dihitung saat apply. Tinjau ulang hasil
  dry-run baru bila baris skipped tetap perlu diubah.
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

Skrip tidak punya mode undo. Pengembalian dilakukan per karyawan lewat kolom
yang sama: Profil karyawan > **Ubah atasan**, oleh HR atau GM brand. Setiap baris
audit `hris.employee_manager_backfill` (dari skrip) dan
`hris.employee_manager_change` (dari layar) menyimpan nilai `managerId` sebelum
perubahan. Prosedur:

1. Operator menentukan tenant, rentang waktu apply, dan karyawan yang perlu
   dikembalikan (atau semuanya), lalu menyerahkannya ke HR.
2. Ambil nilai "sebelum" `managerId` tiap karyawan dari baris audit action
   `hris.employee_manager_backfill` untuk tenant dan rentang waktu itu. Role HR
   tidak bisa membuka log audit (butuh `audit.log.view`, yang dipegang
   `tenant_admin` dan `owner`). Jadi `tenant_admin` atau `owner` membuka
   `/audit`, menyaring action dan tanggal, lalu menyerahkan daftar karyawan
   dan UUID "sebelum" ke HR.
3. Audit menyimpan UUID atasan, bukan nama. Untuk tahu siapa pemilik sebuah
   UUID, buka `/kelola/karyawan/<uuid>` (HR atau GM yang bisa melihat orang itu).
   Lalu HR atau GM brand membuka Profil karyawan > Ubah atasan dan memilih
   atasan "sebelum" itu. Bila nilai sebelumnya kosong, pilih **Tanpa atasan**.
4. Isi "Alasan", misalnya "rollback backfill legend-qhqf8 512". Pengembalian
   tercatat sebagai baris audit `hris.employee_manager_change` sendiri.

Bila atasan "sebelum" sudah tidak aktif, layar menolak dengan pesan atasan tidak
aktif; pilih atasan aktif lain atau **Tanpa atasan**, dan catat keputusannya di
alasan. Bila pengembalian ditolak karena lingkaran atau peran, baca pesan di
bagian 2.

Efek mengembalikan atasan menjadi kosong: karyawan itu hilang lagi dari layar
supervisor dan outlet manager, jadi lakukan sebelum scope 502 dibuka.

## Batasan

- Hanya karyawan `active`. Karyawan `onboarding`, `suspended`, `resigned`,
  `terminated` tidak diperiksa.
- Skrip tidak membaca atau mencetak nama lengkap dan user id.
- Skrip tidak menyentuh baris `manual`, apa pun isi `--manifest`.
- Skrip tidak mengubah GM atau akses scope brand.
- Skrip tidak menyelesaikan daftar manual dan tidak punya undo. Keduanya
  dikerjakan di layar Profil karyawan > Ubah atasan.
