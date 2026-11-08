# Brief: engineer — fix temuan review legend-zoqc

Lanjutan brief 10, worktree dan cabang yang sama (`.worktrees/db-role-provisioning`, `ws/db-role-provisioning`, HEAD `4d5f34f`).

## Urutan

1. Semua temuan **Tinggi** dari second-opinion (blocker). Tiap fix wajib punya test regresi yang gagal sebelum fix (buktikan dengan revert sesaat, seperti yang sudah kamu lakukan).
2. Temuan **Sedang** dari kedua reviewer.
3. Temuan **Rendah**: kerjakan yang murah (docs, pesan error, `deploy.sh` peringatan / audit setelah migrate, PG16+ wajib). Sisanya jadi bead lanjutan.
   Temuan yang menurutmu bukan masalah nyata: tulis alasan teknisnya di laporan, jangan diam-diam dilewati.

## Bukti selesai

Sama dengan brief 10 (check, build, test:setup, format, color, tenant-hardcode, git bersih), plus subagent reviewer konteks segar atas diff fix. Commit lokal merujuk `legend-zoqc`.

## Laporan

Tabel temuan → fix/commit/test, atau alasan ditolak; bead baru; bukti perintah.

---

## Temuan second-opinion (Codex, gpt-6.1-sol, direproduksi di PG16)

⚠️ **Temuan — ada blocker keamanan:**

- **Tinggi — [apps/api/src/db/provision-roles.ts:52](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/apps/api/src/db/provision-roles.ts:52>):** Validasi memakai username/password authority URL, sementara `pg` mendahulukan query parameter. URL worker dengan authority terbatas dan `?user=<admin>&password=<admin>` lolos job; koneksi worker terbukti menjadi superuser. **Fix:** Validasi konfigurasi efektif parser `pg` atau tolak parameter pengganti identitas/endpoint; tambahkan tes identitas koneksi aktual.

- **Tinggi — [deploy/single-vm/provision-roles.sh:38](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/deploy/single-vm/provision-roles.sh:38>):** Wrapper memeriksa path dari `compose.env`, tetapi Compose mendahulukan variabel shell. Mengekspor `API_ENV_FILE` ke file lain berisi `MIGRATION_DATABASE_URL` membuat dry-run sukses sementara konfigurasi API menerima kredensial admin. **Fix:** Pin path yang sudah diperiksa untuk seluruh pemanggilan Compose atau validasi konfigurasi efektif secara aman; tes override shell.

- **Tinggi — [apps/api/src/db/provision-roles.ts:291](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/apps/api/src/db/provision-roles.ts:291>):** Audit mengabaikan `pg_default_acl`. `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO legend_app` lolos provisioning; tabel tenant berikutnya tetap menerima TRUNCATE setelah `enforce_tenant_rls`. Reproduksi berhasil menghapus seluruh baris lintas tenant tanpa konteks tenant. **Fix:** Tolak atau normalkan default ACL berlebih untuk login, grup, dan PUBLIC; tambahkan regresi tabel yang dibuat sesudah job.

- **Tinggi — [apps/api/src/db/provision-roles.ts:300](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/apps/api/src/db/provision-roles.ts:300>):** `has_table_privilege` melewatkan grant per kolom. Grant `SELECT(email)` kepada worker membuat job tetap sukses, lalu worker berhasil membaca email dari tabel di luar registry. **Fix:** Periksa `has_any_column_privilege` untuk SELECT/INSERT/UPDATE/REFERENCES; tambahkan tes drift tingkat kolom.

- **Tinggi — [deploy/single-vm/provision-roles.sh:73](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/deploy/single-vm/provision-roles.sh:73>):** `compose config --quiet` tetap mencetak rahasia pada error parsing. `APP_DATABASE_URL="<URL>` tanpa kutip penutup lolos pemeriksaan wrapper, kemudian stderr Compose memuat URL beserta password plaintext. **Fix:** Tangkap dan sanitasi error parsing Compose, tampilkan pesan generik, serta tes malformed quoting menggunakan Compose nyata.

- **Sedang — [apps/api/src/db/provision-roles.ts:207](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/apps/api/src/db/provision-roles.ts:207>):** ADMIN OPTION diperiksa hanya pada membership langsung login. `GRANT review_aux TO legend_app WITH ADMIN TRUE` lolos; aplikasi kemudian berhasil `SET ROLE legend_app` dan memberikan `review_aux` kepada login lain. **Fix:** Tolak membership tambahan pada `legend_app` atau audit membership dan ADMIN OPTION secara rekursif.

- **Sedang — [apps/api/src/db/provision-roles.ts:295](</Users/ifanshori99/Projects/legend super app/legend/.worktrees/db-role-provisioning/apps/api/src/db/provision-roles.ts:295>):** Daftar hak mengabaikan `MAINTAIN` pada PostgreSQL 17 yang digunakan Compose tes. Drift grant ini lolos audit dan mengizinkan REINDEX, CLUSTER, serta REFRESH MATERIALIZED VIEW. **Fix:** Tambahkan pemeriksaan sesuai versi server dan regresi PostgreSQL 17. [Dokumentasi PostgreSQL](https://www.postgresql.org/docs/17/ddl-priv.html#DDL-PRIV-MAINTAIN).

## Temuan reviewer (Claude Opus, baca kode; tidak ada blocker menurutnya)

⚠️ **Temuan (urut dari paling berat):**

- **Sedang: default privileges tidak dicek, dan audit tidak diulang tiap rilis.** Lokasi: `apps/api/src/db/provision-roles.ts:284-325` dan `deploy/single-vm/deploy.sh:21`.
  - Masalah: `pg_default_acl` tidak pernah diperiksa. `assertTableRights` hanya melihat tabel yang sudah ada saat job jalan, dan `deploy.sh` menjalankan migrasi tanpa menjalankan ulang job.
  - Skenario: seseorang menjalankan `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO legend_app`. Tabel dari migrasi berikutnya otomatis memberi app TRUNCATE (mengabaikan RLS) dan TRIGGER, dan tidak ada yang mendeteksinya.
  - Fix: tolak entri `pg_default_acl` yang grantee-nya `legend_app`, login app/worker, atau PUBLIC dengan hak di luar SELECT/INSERT/UPDATE/DELETE. Lalu jalankan `provision-roles` (atau mode audit saja) setelah `migrate` di `deploy.sh`.
- **Sedang: test tidak membuktikan klaim "plaintext tidak sampai ke server".** Lokasi: `tests/db-role-provisioning.test.mjs:143-150`.
  - Masalah: regex `^SCRAM-SHA-256\$4096:` tetap lolos kalau kode mengirim `PASSWORD '<plaintext>'`, karena Postgres 17 meng-hash dengan default 4096 iterasi. Plaintext lalu bisa muncul di statement log.
  - Fix: set `scram_iterations = 5000` di database test, lalu tetap assert `$4096:`. Hanya verifier buatan klien yang lolos.
- **Sedang: atribut role worker tidak pernah dites.** Lokasi: `tests/db-role-provisioning.test.mjs:275-296`.
  - Masalah: penolakan `SELECT zoqc_fixture` muncul karena tidak ada GRANT, bukan karena RLS.
  - Skenario: worker mendapat BYPASSRLS atau CREATEROLE, dan test tetap hijau.
  - Cabang ini juga tidak punya test:
    - Pengecekan transitif `unsafe` (`provision-roles.ts:174-185`).
    - Pengecekan grup `extra` (`:224-230`).
    - `legend_app` yang punya atribut elevated (`:362-372`).
    - Cabang `upsertLogin` selain CREATEDB (`:125-135`).
  - Fix: assert `pg_roles` worker, dan tambah drift test seperti `GRANT <role bypass> TO legend_app`, `ALTER ROLE legend_app CREATEROLE`, dan `GRANT other_role TO app`.
- **Sedang: pengecekan "tidak ada rahasia di output" hanya di jalur sukses.**
  - Lokasi: `tests/db-role-provisioning.test.mjs:126,141,312` dan `apps/api/src/provision-roles.ts:33-43`.
  - Masalah: `assertNoSecrets` tidak dipanggil di run yang gagal. Jalur error non-`ProvisionError` (host mati, password admin salah) tidak pernah dites.
  - Masalah kedua: cek argv wrapper hanya mencari URL utuh (`test:577-581`). Stub `docker` tidak mencetak apa pun, jadi cek kebocoran output tidak pernah bisa gagal.
  - Masalah ketiga: `dist/provision-roles.js` yang dipakai saat deploy tidak pernah dijalankan; yang dites hanya `tsx src/...`.
  - Fix: panggil `assertNoSecrets` di dalam `runJob` untuk semua run. Tambah kasus password admin salah dan port mati. Cek argv per password. Buat stub mencetak `$APP_DATABASE_URL` sekali. Jalankan file dist sekali.
- **Sedang: klaim "tabel baru setelah job tetap ter-grant" hanya membuktikan helper migrasi.** Lokasi: `tests/db-role-provisioning.test.mjs:188-197`.
  - Masalah: tabel di test di-grant oleh `app.enforce_tenant_rls` (migrasi `0001:49`), bukan oleh job. Ini sah karena desainnya memakai grup, tapi tidak menguji job.
  - Fix: beri nama test sesuai yang diuji, dan tambah test default privileges dari temuan pertama.
- **Sedang: idempoten, rotasi, dan rollback belum benar-benar dibuktikan.**
  - Masalah: idempoten hanya dicek dari "exit 0 + `updated`". Tidak ada snapshot katalog sebelum dan sesudah, tidak ada test rotasi password (password lama ditolak, yang baru diterima), dan tidak ada test dua run bersamaan.
  - Masalah kedua: tidak ada test bahwa run gagal tidak mengubah `rolpassword` (komentar di `test:320-321` mengklaim rollback).
  - Fix: `deepEqual` snapshot katalog antara run 1 dan run 2, tambah test rotasi, dan cek `rolpassword` tidak berubah setelah run yang gagal.
- **Rendah: ganti nama login worker membuat job macet.** Lokasi: `apps/api/src/db/provision-roles.ts:432-435`.
  - Masalah: schema `pgboss` masih dimiliki nama lama, jadi job selalu gagal dengan "owned by a different role". Prosedurnya tidak ada di docs.
  - Fix: dokumentasikan `ALTER SCHEMA pgboss OWNER TO <baru>`, atau beri pesan error yang menyebut langkah itu.
- **Rendah: `--dry-run` belum memvalidasi format URL.** Lokasi: `deploy/single-vm/provision-roles.sh:70-75`.
  - Masalah: pesan "Validated env files" muncul walau pola nama login, password 48 hex, dan kesamaan host tidak dicek. Kesalahan baru ketahuan setelah migrasi jalan.
- **Rendah: saran error tidak cocok untuk VM.** Lokasi: `apps/api/src/provision-roles.ts:30-44`.
  - Masalah: saat ECONNREFUSED, pesannya "Start Docker and run pnpm db:up", yang hanya relevan untuk dev lokal.
- **Rendah: jalur PG < 16 tidak dites.**
  - Masalah: test memakai `inherit_option` dan `WITH INHERIT FALSE`, yang hanya ada di PG16+, dan CI hanya pakai `postgres:17-alpine`. Cabang `< 160000` tidak pernah dijalankan.
  - Fix: hapus cabang lama, atau tulis bahwa PG16+ wajib.
- **Rendah: urutan test saling bergantung.** Lokasi: `tests/db-role-provisioning.test.mjs:459-461`.
  - Masalah: test non-superuser butuh `legend_app` dari `db:migrate` di test pertama, jadi gagal bila dijalankan sendiri.
- **Rendah: test registry terlalu lemah.** Lokasi: `tests/db-role-provisioning.test.mjs:282`.
  - Masalah: `SELECT ... active_tenant_registry LIMIT 1` lolos walau hasilnya nol baris, dan filter tenant aktif vs suspended tidak dites.
- **Rendah: tidak ada pengaman bila `deploy.sh` jalan sebelum provisioning.**
  - Skenario: di VM baru, `deploy.sh` jalan duluan. API dan worker restart terus karena login gagal, dan satu-satunya petunjuk adalah error auth.
  - Fix: tambah peringatan di `deploy.sh`.
