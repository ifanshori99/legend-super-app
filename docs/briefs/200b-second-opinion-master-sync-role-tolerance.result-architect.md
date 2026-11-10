# 200b hasil architect (pengganti Codex) — legend-dhbt1

Rentang: `git diff 12c91f6b..ws/master-sync-role-tolerance` (tip b28982a1), tanpa `docs/`.
Status cabang: belum digabung ke `milestone/m1`. Tidak ada commit di m1 sesudah 12c91f6b yang menyentuh
`packages/shared/src/edge/master-sync.ts`, `apps/api/src/edge/master-sync.ts`,
`apps/api/src/services/edge-master-sync.service.ts` atau `apps/api/src/test/edge-master-sync.test.ts`.
`git merge-tree milestone/m1 ws/master-sync-role-tolerance`: kode bersih, konflik hanya `docs/PROGRESS.md`.

## Hasil: Bersih

Tidak ada temuan P1/P2.

## Invariant yang diperiksa
- HMAC atas snapshot persis seperti diterima, sebelum filter: benar. `fetchVerifiedMasterSnapshot`
  (`apps/api/src/edge/master-sync.ts:138`) cek signature atas `snapshot` mentah, lalu schema parse (:140);
  `partitionEdgeMasterMappings` baru dipanggil di apply (:192). Test dhbt1 menandatangani snapshot yang
  memuat role asing, jadi filter sebelum cek tanda tangan akan gagal test.
- Role kosong, >40 karakter, duplikat tetap BAD_SNAPSHOT dan tidak menulis apa pun: benar.
  `packages/shared/src/edge/master-sync.ts:110` (`z.string().min(1).max(40)`), cek duplikat di superRefine
  :184-188 (berlaku juga untuk role asing). Parse gagal sebelum transaksi dibuka. Test "bounded string" memeriksa
  ketiganya dan `dbView` tidak berubah.
- Role asing dibuang, sisa snapshot diterapkan: benar. Uom, lokasi, akun memakai `snapshot.*` tanpa filter;
  hanya mapping memakai `known` (:301). Akun yang dipetakan oleh role asing tetap ter-upsert (benar: akun
  adalah master sendiri).
- Role dikenal ter-upsert, set cloud (role dikenal) menggantikan set lokal, role dikenal di snapshot tidak
  pernah terhapus: benar. `keptRoles = mappings.map(role)` (:316) memuat semua role dikenal yang di-upsert, jadi
  `notInArray` tidak bisa menghapusnya. Semua role asing dibuang: `keptRoles` kosong, semua mapping lokal entitas
  dihapus. Ini konsisten dengan aturan "set cloud menggantikan set lokal" dan diuji.
- Log hanya nama role dan jumlah (:330-334): benar. Nilai berasal dari snapshot yang sudah lolos HMAC, dibatasi
  200 x 40 karakter, dan pino meng-escape JSON.
- Counter `droppedMappings` di `EdgeMasterSyncCounts` (:73, :340): benar. Pemakai tipe ini hanya
  `applyEdgeMasterSnapshot`, `syncEdgeMasters`, bootstrap (`apps/api/src/edge/bootstrap.ts:304`, nilai balik
  diabaikan) dan loop (`logger.debug({...counts})`). Tidak ada schema respons ketat yang ikut rusak.
- Tanpa migrasi: benar. `account_mappings.role` tetap `varchar(40)` dengan `$type<PostingAccountRole>()`
  (`apps/api/src/db/schema/accounting.ts:140`). Insert memakai `KnownEdgeMasterAccountMapping`, jadi tipe tetap rapat.
- Builder cloud (`apps/api/src/services/edge-master-sync.service.ts:185-245`) tetap benar. Kolom DB varchar(40)
  dan unique (tenant, entity, role), jadi role yang dikirim selalu 1-40 karakter dan tidak duplikat. Satu-satunya
  perubahan perilaku: baris cloud dengan role yang tidak dikenal enum cloud sendiri kini terkirim, bukan 409. Ini
  lebih toleran dan aman karena edge membuangnya.

## Catatan P3 (tanpa kartu)
1. `apps/api/src/edge/master-sync.ts:328-334`: warn ditulis sebelum commit. Bila apply gagal sesudahnya
   (LOCAL_WRITE), log tetap menyebut role dibuang. Komentar kode sudah mengakuinya. Bisa dipindah ke
   `applyEdgeMasterSnapshot` sesudah `withTenant` selesai.
2. Kelas masalah yang sama masih ada untuk enum tertutup lain di snapshot: `accountTypeSchema`,
   `reportGroupSchema`, `stockLocationTypeSchema` dan `version: z.literal(...)`
   (`packages/shared/src/edge/master-sync.ts`). Cloud baru yang menambah nilai di enum itu tetap membuat edge lama
   BAD_SNAPSHOT dan seluruh sinkron master berhenti. Baris akun/lokasi tidak bisa dibuang seperti mapping karena
   dirujuk ledger dan stok. Saran: perluas aturan rilis di header (bangun edge dulu, nilai enum hanya additive)
   agar juga mencakup enum ini. `reportGroupSchema` belum berubah sejak c2e507a9, jadi risikonya rendah.
3. Warn berulang tiap sinkron (>= 60 dtk) selama cloud lebih baru. Volumenya terbatas dan sudah dicatat di komentar.
   `droppedMappings` belum muncul di health/status edge. Ini hanya relevan bila nanti perlu dipantau.

## Catatan rilis (bukan temuan kode)
Edge master sync belum ada di `main`, jadi belum ada edge pra-dhbt1 di lapangan. `payroll_custom_deduction`
belum ada di m1. Urutan di kartu sudah benar: dhbt1 digabung sebelum atau bersama `ws/payroll-journal-followups`.
