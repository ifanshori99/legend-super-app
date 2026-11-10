# 166: second opinion, guard master edge dan limiter bootstrap (legend-uznb + legend-8izz)

Tingkat K (keamanan, blocker rilis). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang

- Cabang `ws/edge-masters-guard`, worktree `.worktrees/edge-masters-guard`.
- Basis `a8c90378` (milestone/m1) sampai `d2beba65`.
- `git diff a8c90378..d2beba65`
- Tidak ada migrasi.

## legend-uznb: limiter `/edge/bootstrap/masters` (+ Codex 119)

- Masalah:
  - `GET /api/edge-sync/bootstrap/masters` tidak punya limiter.
  - Limiter bootstrap jalan di dalam router, sesudah resolusi tenant (`app.ts`). Akibatnya flood dari satu IP tetap menjalankan query `tenant_domains JOIN tenants` sebelum 429.
- Perubahan:
  - `apps/api/src/routes/edge-bootstrap.routes.ts`: fungsi baru `createEdgeBootstrapRateLimit`.
    - `/masters` punya bucket sendiri: 120 per IP dan 30 per IP + kredensial (hash sha256 bearer).
    - Rute bootstrap lain tetap 30 per IP dan 10 per kredensial.
    - Kredensial di-parse dari bearer tanpa DB dan tanpa tenant.
    - Bucket kedua tidak dibebani bila bucket IP sudah menolak.
  - `apps/api/src/app.ts`: limiter di-mount hanya pada `/api/edge-sync/bootstrap`, sesudah `edgeRouteGuard` dan sebelum middleware tenant `/api`.
  - Router tetap memasang limiter yang sama. Request yang sudah dihitung di `app.ts` dilewati lewat `WeakSet<Request>` di sisi server, yang tidak bisa diatur klien.
  - `docs/deployment.md`: bagian "Edge bootstrap limits" tentang NAT outlet dan `TRUST_PROXY`.
- Test `apps/api/src/test/edge-bootstrap-rate-limit.test.ts`:
  - Mounted-app menghitung query domain: tidak ada query baru setelah 429. Test gagal bila mount `app.ts` dicabut.
  - `/masters` di atas batas bootstrap.
  - Bucket per device di satu IP, dan per IP lintas device.
  - Pemalsu yang tahu node id tapi tidak tahu secret tidak bisa menghabiskan bucket node asli.

## legend-8izz: `syncEdgeMasters` lewat `guardDataImport`

- Masalah: `apps/api/src/edge/master-sync.ts` menulis uoms, stock locations, COA dan account mappings tanpa `guardDataImport`.
- Perubahan:
  - Helper `guardMasterImport()` memanggil `guardDataImport("edge.bootstrap")`; penolakan menjadi `EdgeMasterSyncError("DATA_IMPORT_BLOCKED")`.
  - Guard dipanggil di awal `syncEdgeMasters` (sebelum fetch cloud) dan di awal `applyEdgeMasterSnapshotInTransaction` (sebelum tulisan pertama, dalam satu transaksi), jadi tidak ada tulisan sebagian.
  - `bootstrap.ts`: hanya komentar. Node yang sudah bootstrap tetap boot dan mencatat penolakan; loop tetap jalan.
  - Guard hanya memeriksa kebijakan deployment (data nyata hanya di production), jadi penolakan berlaku untuk semua baris sekaligus, tidak per baris.
- Test:
  - `edge-master-sync.test.ts` "legend-8izz master sync behind the data import guard": sync ditolak tanpa panggilan cloud dan keempat jenis tidak ditulis; apply langsung ditolak; node yang sudah ada tetap boot; diterima bila guard mengizinkan.
  - `data-import-registry.test.ts`: cek statis bahwa guard dipanggil sebelum tulisan atau fetch. File ini tidak bernama import, jadi pindaian nama file melewatinya.

## Codex 124: galat DB di endpoint masters

- Masalah: `apps/api/src/services/edge-master-sync.service.ts` meneruskan galat DB mentah. Saat query timeout, `DrizzleQueryError` berisi SQL dan parameter tenant, outlet dan node, lalu dicetak logger HTTP lewat `res.err`.
- Perubahan: pembacaan snapshot dibungkus. Hanya galat DB (`DrizzleQueryError` atau `pg.DatabaseError`) yang menjadi `CoreError("SERVICE_UNAVAILABLE")` (503), dengan pesan tetap dan tanpa `cause`. Log hanya kelas galat dan SQLSTATE. Galat lain, termasuk `CoreError` (FORBIDDEN, CONFLICT) dan penolakan role DB tidak aman dari `withTenant`, tetap di jalurnya sendiri. Jalur 500 sudah membersihkan nilai baris dari `res.err`.
- Test `edge-master-sync.test.ts` "Codex 124 ...":
  - Transaksi pembacaan masters dibuat gagal dengan `DrizzleQueryError` berisi sentinel, SQL dan id. Transaksi verifikasi kredensial dibiarkan lewat.
  - Galat dari service (message, stack, JSON, properti), isi `logger.warn`, dan body respons 503 tidak memuat sentinel, id, kredensial, atau teks "Failed query". Request berikutnya kembali 200.
  - Galat non-DB tidak diubah menjadi 503.

## Review K

- Reviewer Opus: tidak ada high atau medium. Dua low, keduanya DIPERBAIKI:
  - Bucket device memakai node id, bukan hash bearer, sehingga pemalsu di IP yang sama bisa membuat node asli kena 429.
  - Bucket kedua tetap dibebani walau IP sudah ditolak.
- Reviewer Opus (Codex 124):
  - Test memalsukan `db.transaction` milik verifikasi kredensial, bukan pembacaan masters (high): DIPERBAIKI.
  - Catch terlalu lebar, menyembunyikan galat non-DB sebagai 503 (medium): DIPERBAIKI, hanya galat DB.
  - Isi log tidak diuji (low): DIPERBAIKI.
  - `org-resolve.service.ts:23` meneruskan `DrizzleQueryError` mentah ke jalur 500 untuk semua rute; teks SQL (tanpa nilai) masuk `res.err` (low, sudah ada sebelumnya): bead terpisah.
  - DB mati saat verifikasi kredensial dijawab 401, bukan 503 (info).
- Architect: disetujui. Temuan:
  - Bucket kedua tetap dibebani (low): DIPERBAIKI.
  - NAT bersama dan `TRUST_PROXY` (medium-low, bawaan limit per IP): DIDOKUMENTASIKAN.
  - Cek statis registry (low): DITAMBAHKAN.
  - Log berulang saat guard terus menolak (info): tidak dikerjakan.

## Yang perlu dilihat second opinion

- Urutan middleware `app.ts`: hanya path bootstrap yang terkena, dan tidak ada akses DB sebelum 429.
- Batas 120/30 per menit cukup untuk polling `/masters` armada edge di satu outlet.
- Store limiter ada di memori per proses (LRU 20.000). Dengan N instance API, total batas menjadi N kali.
- Semantik guard: `guardDataImport` hanya kebijakan deployment. Benarkah itu maksud "perilaku sama seperti impor data"?
