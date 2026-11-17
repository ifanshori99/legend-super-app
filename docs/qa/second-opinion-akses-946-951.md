# Second opinion akses 946 + 951

Tanggal: 17 November 2026. Pemeriksaan statis independen sesuai brief 957, dengan tiga subagent Codex paralel (puncak tiga; tanpa pekerjaan `heavy`).

Hasil: **P0: 0, P1: 0, P2: 1, P3: 0.** Tidak ditemukan bypass akses atau kehilangan data baru yang dapat dibuktikan pada jalur yang diperiksa. Satu celah cakupan rotasi masih perlu ditangani sebelum kunci lama dipensiunkan.

## Rentang dan metode

- **946:** `8a661cd906451ce2769bd07f61cff1c3446ea55f..a3f7af1a17695cc79352e64ab09379fb861ef27f` (`origin/ghostex/a46177dd` saat pemeriksaan).
- **951:** `c17c60df7ca80f4dc4af8de06faae4e43d40ac80..b4f260a9863b2be99f921f9e0ed9fdf78e9a95e2` (`origin/ghostex/ws-01-pengerasan-akses-951` saat pemeriksaan).
- **Sumber:** `git diff`, `git show`, penelusuran pemanggil/SQL dan test dalam ref tersebut. Nomor baris di bawah mengacu pada SHA tujuan masing-masing, bukan checkout folder kerja.
- **Batas kerja:** Tanpa worktree, checkout, perubahan kode, commit, atau push. Satu-satunya berkas yang ditulis pemeriksa adalah laporan ini. Status Beads dan pencatatan commit ditangani CTO.
- **Pengecualian CTO:** Empat kolom tersegel pada tabel beku (`legend-4vfmn`), desain envelope byte tetyr, serta alert batas basi ke cloud (`legend-uvnll`) tidak dihitung sebagai temuan.

## Temuan

### P2-1 — Snapshot kode voucher dalam JSON idempotensi belum ikut rotasi

**Lokasi diff:** `apps/api/src/worker/sealed-secret-reseal.job.ts:8` dan `:559`. Job secara eksplisit melewati rahasia dalam JSON; penghitungan hasil hanya mengiterasi `SEALED_SECRET_COLUMNS` pada `:571` dan `:580`. `promo_command_idempotency.response` tidak ada dalam registry tersebut.

**Bukti pemakai:** `apps/api/src/services/crm-promo.service.ts:824` menyusun AAD `promo-voucher-idem:<tenant>:<key>`, menyegel `response.code` pada `:834`, dan membuka kembali pada `:841`. `apps/api/src/services/apology-voucher.service.ts:966` memakai AAD `apology-voucher-idem:<tenant>:<key>` untuk `response.voucher.code` pada `:982` dan `:993`. Keduanya disimpan dan diputar ulang oleh `apps/api/src/services/crm-promo-idempotency.ts:74`, `:94`, dan `:104`. Snapshot JSON ini terpisah dari `apology_vouchers.code_sealed` yang masuk pengecualian tabel beku CTO.

**Skenario gagal:** Terbitkan voucher promo dan voucher permintaan maaf dengan `Idempotency-Key` ketika key 2 aktif. Aktifkan key 3 dan jalankan sweep. Snapshot JSON tetap memakai key 2, bahkan jika seluruh kolom registry telah selesai dipindahkan atau kosong sehingga laporan registry menunjukkan `remaining: 0`. Bila key 2 kemudian dihapus dari keyring, retry dengan kunci idempotensi yang sama gagal pada `openSecret`; respons awal beserta kode voucher tidak dapat dipulihkan melalui replay.

**Dampak dan batas:** Rotasi rahasia promo/voucher belum lengkap, sehingga pensiun key lama masih terhalang oleh data di luar laporan sisa job. Diff ini **tidak** memensiunkan key otomatis, dan komentar `:15` sudah melarang pensiun sebelum rahasia di luar registry ikut dipindahkan. Karena itu ini P2 berupa pekerjaan rotasi yang belum tercakup, bukan bukti kehilangan data saat sweep atau pembayaran/voucher ganda.

**Saran:** Tambahkan sweep resumable untuk kedua operasi JSON, dengan AAD asli, filter tenant, serta penguncian/CAS yang mempertahankan fingerprint dan isi respons lain. Jika pemindahannya ditunda, masukkan sisa JSON tersebut dalam laporan dan syarat operasional pensiun key; jangan memakai nol pada registry kolom sebagai bukti seluruh rahasia sudah pindah.

**Usul test:** Terbitkan kedua jenis voucher melalui command asli dengan key 2 dan kunci idempotensi berbeda. Jalankan sweep ke key 3, ulangi sweep untuk membuktikan idempotensi, lalu gunakan keyring berisi key 3 saja. Replay harus mengembalikan kode yang sama, jumlah/nilai voucher tidak bertambah, dan tidak ada pencatatan keuangan kedua. Seed tenant lain dan gangguan antar-batch untuk membuktikan isolasi serta kelanjutan sweep. Bila memilih penundaan, test harus membuktikan sisa JSON tetap terhitung dan syarat pensiun key belum terpenuhi.

## Hasil area lainnya

- **946 / batas basi:** Tidak ditemukan temuan baru yang konkret. Admission terpusat dipanggil dari kredensial perangkat dan heartbeat; jalur pos-session ditolak sebelum penerbitan acting-staff ketika perangkat tidak memiliki sesi berjalan. Pengecualian hanya pembacaan `GET /api/edge/status`, tanpa memperbarui aktivitas. Status `not_ready` menahan sesi baru dan tidak memajukan `lastSeenAt`. Test baru mencakup stale pos-session, tidak adanya token acting-staff saat ditolak, checkpoint belum siap, dan keberlanjutan sesi berjalan; test tersebut dibaca, tidak dijalankan ulang.
- **951 / pencabutan akses manajer:** Tidak ditemukan mutasi tanpa izin yang dapat dibuktikan. Advisory lock tenant, penguncian assignment target dan custom role, serta pemeriksaan ulang memakai waktu setelah lock melindungi penulisan manager. Kandidat replay idempotensi tidak dihitung sebagai temuan: guard route memakai akses aktual, replay terikat actor dan hanya mengembalikan respons lama tanpa mutasi atau pembacaan data pegawai baru; pola replay itu juga sudah ada pada baseline.
- **951 / email peminta dukungan:** `requestDtos` memakai `actorNames`, termasuk penyaring nama kosong atau nama yang mengandung `@`. Tidak ditemukan jalur DTO baru yang melewati penyaring tersebut.
- **951 / dokumen pemegang saham:** Filter tenant, pengguna, pemegang saham aktif, dan versi approved yang efektif sudah ada pada baseline. Diff d3quc menambah test regresi, bukan perubahan implementasi akses. Tidak ditemukan kebocoran lintas tenant atau jalur versi dokumen yang melanggar filter tersebut.
- **951 / kolom registry rotasi:** Tidak ditemukan kehilangan data baru yang konkret pada 17 kolom registry. Pemeriksaan mencakup AAD, row lock, CAS, savepoint, cursor kelanjutan, dan penghitungan sisa termasuk baris beku. Nol pada registry ini hanya mencakup registry; header job juga menyebut rahasia ChatGPT/push di luar cakupan.

## Verifikasi dan batas kepastian

- **Dilakukan:** Pemeriksaan diff pada SHA tetap, pembandingan baseline untuk kandidat temuan, dan penelusuran writer/reader untuk membuktikan skenario P2-1. Berkas hasil diperiksa untuk encoding UTF-8, newline akhir, spasi akhir baris, dan struktur temuan.
- **Pemeriksaan format terhalang:** `pnpm exec prettier --write docs/qa/second-opinion-akses-946-951.md` gagal sebelum berjalan: `MODULE_NOT_FOUND` untuk `node_modules/prettier/bin/prettier.cjs`. Perintah `--check` dalam rangkaian yang sama tidak sempat berjalan. Dependensi tidak dipasang ulang agar batas hanya menulis berkas hasil tetap dipatuhi.
- **Tidak dijalankan:** Test API/database, reproduksi runtime, migrasi, typecheck, build, dan e2e. Folder checkout bukan ref yang direview; pemeriksaan dilakukan melalui objek Git sesuai instruksi pengganti saat disk penuh. Tidak ada klaim bahwa test pada kedua cabang sudah lulus dari run ini.
- **Tindak lanjut:** Tangani P2-1 sebelum pensiun key lama dan jalankan usul test pada cabang perbaikannya. Hasil ini adalah second opinion statis, bukan bukti gerbang rilis runtime.
