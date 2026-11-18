# Second opinion gerbang rilis 1109

Review 18–19 November 2026, sesuai `docs/briefs/1109-second-opinion-gerbang-rilis.md`. Hasil: **3 temuan P2; tidak ada temuan P0, P1, atau P3** dalam cakupan yang diperiksa. Temuan ini belum diperbaiki.

## Cakupan

`git fetch origin` berhasil. Pemeriksaan memakai diff tiga titik terhadap `origin/milestone/m1`, mengecualikan `**/meta/*snapshot.json`, dan penelusuran sekitar yang diperlukan untuk membuktikan skenario.

| Area              | Revisi yang diperiksa                      |
| ----------------- | ------------------------------------------ |
| Milestone         | `4418628e0dd002d2fb5af07a6bc15f74390af162` |
| 1097 payout/rekon | `7585a887fdb586f8c7e133be041c631931c6b041` |
| 1098 DOIT/Duitku  | `7ada4e49b5d06b94d0ad02b72f1105d6cf49d055` |
| 1100 deploy       | `2db9947b6b701bbabcd155cd5cf01da7ec40aae2` |

Nomor baris berikut merujuk revisi area masing-masing, bukan checkout utama. Tiga subagent memeriksa ketiga area secara paralel, dengan puncak tiga aktif; agent utama menggabungkan dan memeriksa bukti. Tidak ada checkout, perubahan kode, commit, push, atau merge.

## Temuan

### F1 — P2: Gerbang bukti payout dapat lolos sementara histori tetap pending

**Lokasi:** `scripts/preflight/rilis1-legend-9bfh7.sql:6`, juga `:10` dan `:112`, pada area 1097.

CTE `ops` dibentuk dari operasi payout yang memakai bukti. File bukti yang belum dirujuk operasi tidak pernah masuk pemeriksaan. Selain itu, cabang return mengabaikan hash claim yang NULL saat membandingkannya dengan upload record yang lengkap.

**Skenario gagal:** Satu file bukti lama mempunyai `stored_sha256 IS NULL`, tanpa claim/item/correction/proposal yang merujuknya, dan kuncinya belum ditutup. `ops` kosong, sehingga gerbang menghasilkan nol baris dan lolos. Namun predikat di `apps/api/drizzle/0413_payout_proof_closures.sql:45` tetap menganggap file itu pending. Fungsi global di `apps/api/drizzle/0399_payout_proof_global_gate.sql:136` meneruskan status tersebut lintas tenant, sehingga pengembalian, koreksi, dan pencatatan kelebihan bayar dengan bukti baru masih tertahan setelah deploy. Variasi kedua: claim memiliki hash NULL, sedangkan kedua hash upload record lengkap; gerbang juga tidak menandainya, tetapi predikat pending pada `0413:38` menandainya.

**Perbaikan:** Laporkan pula file tanpa stored hash walau belum dipakai operasi, serta claim dengan hash NULL. Arahkan penyelesaian manual sebelum rilis. Ini tidak meminta backfill otomatis legacy: pengecualian `ofu02` tetap diterima; masalahnya adalah `9bfh7` belum memenuhi syarat histori payout tidak pending.

**Usul test:** Pada `apps/api/src/test/preflight-rilis1-payout.test.ts:838`, tambahkan fixture file NULL tanpa seed claim; gerbang harus tetap menghasilkan baris. Tambahkan claim dengan hash NULL dan upload record lengkap. Bandingkan hasil gerbang dengan predikat pending, termasuk kontrol file lengkap dan kunci yang sudah ditutup.

### F2 — P2: Perintah sertifikasi Duitku melewati probe walau kredensial tersedia

**Lokasi:** `docs/qa/duitku-sandbox-gerbang.md:8`, pada area 1098.

Perintah yang didokumentasikan hanya menyetel `LEGEND_TEST_FILES`. Akan tetapi, `apps/api/src/test/payment-duitku-sandbox.test.ts:19` mensyaratkan `DUITKU_SANDBOX_PROBE === "1"` sebelum blok sertifikasi pada `:143` dijalankan.

**Skenario gagal:** Operator memuat kedua kredensial sandbox seperti petunjuk, lalu menjalankan perintah tersebut di luar CI tanpa variabel opt-in. Safety test dapat hijau, sementara sertifikasi tetap dilewati, tidak ada request sandbox, dan bukti tidak diperbarui. Petunjuk gerbang dengan demikian tidak melakukan pemeriksaan yang dijanjikan.

**Perbaikan:** Tambahkan `DUITKU_SANDBOX_PROBE=1` pada perintah dan wajibkan pengecekan waktu `recordedAt` bukti baru serta hasil sertifikasi yang benar-benar dijalankan.

**Usul test:** Jalankan perintah terdokumentasi dengan kredensial dummy dan jaringan yang dimock; pastikan blok sertifikasi berjalan dan bukti diperbarui. Kontrol tanpa opt-in dan kontrol CI tetap tidak boleh memanggil jaringan.

### F3 — P2: Runner menerima statement selain SELECT; READ ONLY tidak membatasi efek eksternal

**Lokasi:** `apps/api/src/db/release-gates.ts:130` dan `:373`, pada area 1100.

Parser hanya memeriksa body tidak kosong dan menolak meta-command psql. Extended protocol membatasi jumlah statement, tetapi runner tidak memeriksa jenis statement atau fungsi yang dijalankan. Semua hasil diperlakukan sebagai kumpulan baris pemeriksaan.

**Skenario gagal:** Berkas dengan header sah dan body `SET LOCAL statement_timeout = '120s'` diterima. Hasil SET mempunyai nol baris, sehingga mode block dicatat berjalan dan lolos tanpa pemeriksaan data. Pada koneksi superuser yang diterima predeploy, satu statement `COPY (SELECT 1 WHERE false) TO PROGRAM 'cat >/dev/null'` juga dapat mengeksekusi program di server sambil menghasilkan nol baris. Program contoh aman; program lain dapat membuat efek eksternal yang tidak dibatalkan `ROLLBACK`. Ini memerlukan perubahan/kerusakan berkas gerbang atau penggantian folder gerbang; tidak ditemukan endpoint pengguna yang langsung memasok SQL tersebut.

**Perbaikan:** Validasi statement sebelum eksekusi: hanya bentuk SELECT yang disetujui, tanpa statement pengaturan/COPY/CTE menulis dan tanpa pemanggilan fungsi berefek samping. Pemeriksaan `result.command` dapat menjadi pertahanan tambahan, tetapi dilakukan setelah eksekusi sehingga tidak cukup mencegah efek eksternal.

**Usul test:** Header sah dengan body SET, COPY TO PROGRAM, dan SELECT fungsi berefek samping harus ditolak sebelum body dijalankan. Sertakan kontrol SELECT biasa, multi-statement, serta CTE menulis. Verifikasi tidak ada efek eksternal yang tersisa setelah penolakan.

## Verifikasi dan batas

- Penelusuran mencakup route/job/webhook recurring, preflight payout/promo, opt-in dan host probe, redaksi rahasia, peran migrator, N/A dengan skema aplikasi sudah ada, drift hash dan daftar izinnya, serta pengemasan SQL dalam image. Tidak ditemukan temuan konkret tambahan pada bagian tersebut.
- Urutan landing tetap wajib: 1097 dan 1098 sebelum 1100. Runner menemukan berkas secara dinamis; hasil pemeriksaan tidak membuktikan bahwa cabang telah digabung dalam urutan tersebut.
- Harness sementara di luar repo dijalankan melalui `heavy vitest run <repro.test.mjs> --root=<fixture> --config=<fixture>/vitest.config.mjs --maxWorkers=1`: **1 berkas, 3 test lulus**, exit 0, durasi 335 ms. Test tersebut sengaja membuktikan perilaku bermasalah saat ini, bukan menyatakan masalah sudah diperbaiki.
- F1: SQL asli gerbang pada SHA 1097 dijalankan di PostgreSQL 17 dengan CTE fixture sintetis yang membayangi seluruh tabel payout. Kedua hasil adalah `pending_by_0413_null_predicates=true`, `preflight_blocking_rows=0`. Fungsi global aplikasi tidak dipanggil langsung; dampaknya dibuktikan lewat penelusuran fungsi migrasi 0399/0413. Tidak ada data aplikasi yang dibaca atau ditulis oleh fixture.
- F2: Ekspresi `enabled` asli dievaluasi dengan kredensial dummy: lingkungan yang didokumentasikan menghasilkan `false`, penambahan opt-in menghasilkan `true`, dan CI tetap `false`. Tidak ada jaringan provider yang dipanggil.
- F3: Parser asli menerima body SET dan COPY. Runner asli, dengan hasil protokol SET yang dimock (`command=SET`, `rowCount=null`, `rows=[]`), mengembalikan `status=ok` serta mencatat gate sebagai berjalan. Secara terpisah, PostgreSQL menerima SET dan `COPY (SELECT 1 WHERE false) TO PROGRAM 'cat >/dev/null'` dalam transaksi READ ONLY, menghasilkan `COPY 0`, lalu ROLLBACK. Jadi bukti runner memakai mock, sedangkan izin SQL read-only dibuktikan pada server asli; integrasi runner lengkap dengan client PostgreSQL asli belum dijalankan.
- Harness berada sementara di `/private/var/folders/jt/kw4k2s7569ld5wkb9hdk7ltr0000gn/T/legend-so1109-1gtzkzmm/repro.test.mjs`, dengan config pada direktori yang sama. Empat job antrean yang sudah digantikan harness ini dihentikan sebelum berjalan; seluruh session mengonfirmasi exit 143. Tidak ada job thread ini yang masih berjalan.
- Prettier berkas laporan lulus melalui paket lokal `prettier@3.9.6` secara langsung; launcher `pnpm exec prettier` memiliki jalur lokal yang rusak. `git diff --check` juga lulus.
- Suite proyek, build, e2e, dan koneksi provider sandbox/production tidak dijalankan. Review ini tidak menyatakan gerbang rilis keseluruhan sudah hijau.
- Pengecualian brief diterima: refund penyedia otomatis mati, recurring DOIT mati, tanpa backfill legacy otomatis, dan service-level DOIT `legend-ww562` tidak dilaporkan ulang.

Hanya berkas laporan ini yang ditulis oleh thread ini; berkas dan pekerjaan lain di checkout bersama tidak disentuh.
