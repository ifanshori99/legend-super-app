# Second opinion edge: placeholder, link, katalog, dan resep (#816)

Tanggal: 15 November 2026. Peran: second-opinion. Kode produk tidak diubah.

## Cakupan dan metode

- Basis `origin/milestone/m1`: `7aacd9f68334b23d4814161f1cf4bf0ca5770f4d`.
- Publisher/placeholder: `origin/ws/edge-master-data-publisher`, `eee03008203cc708832b2379a73dd0f32dd950dd`, dibandingkan dengan merge-base basis; termasuk migrasi 0373.
- Resep/versi: `origin/ws/tax-menu-keyrotation`, `87284cbb78fc217a4bd1bb13f6156a5d271e39f9`, dibandingkan dengan merge-base basis; termasuk 0374 dan 0377. Pajak dan rotasi kunci di luar cakupan brief tidak diaudit.
- Nomor baris di bawah mengacu pada tip masing-masing cabang tersebut, bukan hasil merge hipotetis. Kedua cabang dibaca lewat `git show`/`git diff`, tanpa checkout pada folder utama.
- Tiga subagent read-only, puncak tiga bersamaan: race link; kompatibilitas resep/snapshot; migrasi dan isolasi. Agent utama memeriksa silang lokasi, skenario, dan kesimpulan.
- Laporan lama `docs/qa/second-opinion-edge-64d.md` dibaca dari commit `963feebaa` karena tidak ada pada tip publisher. Temuan lama di luar diff ini tidak dihitung ulang.

## Temuan

P0: **0**. P1: **3**. P2: **0**. P3: **0**.

### 1. P1 — Pemeriksaan brand dan pemindaian HTTP tidak atomik

- `apps/api/src/routes/edge-catalog-sync.routes.ts:53` — Pemeriksaan `isCatalogDeliveryRefused` selesai sebelum transaksi pemindaian dibuka di `:63`; perpindahan brand di antaranya dapat mengirim katalog brand baru ke edge yang masih terprovisi untuk brand lama. Satukan pemeriksaan identitas brand terprovisi dan pemindaian dalam transaksi yang menahan brand outlet stabil.
- Skenario: Node outlet masih terprovisi untuk brand A dan cursor publisher menyimpan A. Request `menu_categories` memperoleh hasil pemeriksaan `false`. Perpindahan outlet A → B kemudian commit, sebelum scanner mulai. Scanner membaca ulang `outlets.brand_id = B` dan mengembalikan HTTP 200 berisi kategori B kepada node lama, padahal aturan cabang mewajibkan provisi ulang setelah perpindahan. Ini kebocoran lintas brand dalam tenant yang sama, bukan temuan lintas tenant P0.
- Bukti: Pemeriksaan menggunakan transaksi sendiri (`apps/api/src/services/edge-master-data-publisher.ts:65`); scanner membuka transaksi lain (`apps/api/src/services/edge-catalog-sync.ts:848`), membaca brand saat itu pada `:876`, lalu memakai brand tersebut pada `:894`. Tidak ada kunci outlet atau pemeriksaan cursor publisher di transaksi scanner.
- Usul perbaikan: Ambil kunci outlet `FOR SHARE` sebelum pemeriksaan brand terprovisi, lalu periksa refusal dan scan dalam transaksi yang sama. Jalur perubahan brand harus menghormati kunci tersebut. Tentukan pembacaan yang sudah dimulai sebelum perpindahan sebagai satu snapshot konsisten; jangan memeriksa A lalu memindai B.
- Usul test: Seed kategori A/B dan cursor publisher A. Bungkus pemeriksaan asli agar setelah memperoleh `false`, test melakukan dan menyelesaikan perpindahan ke B sebelum route meneruskan scanner. Pastikan tidak ada respons kategori B; implementasi sekarang menghasilkan 200 berisi B. Setelah perbaikan atomik, uji dua urutan sah: pembacaan A selesai sebelum perpindahan, atau request sesudah perpindahan ditolak 403. Test sekarang di `apps/api/src/test/edge-brand-move-fail-closed.test.ts:202` memulai request setelah perpindahan dan pemblokiran selesai, sehingga tidak menangkap celah ini.
- Bukti terkait pada link: `apps/api/src/services/edge-queue.service.ts:125` memeriksa tanpa kunci lalu `apps/api/src/edge/db-link-store.ts:395` membaca antrean pada statement berikutnya. Batch lama yang sudah dibaca sebelum perpindahan tidak dihitung sebagai temuan terpisah; pembaruan brand tidak bisa menarik kembali frame yang sudah terkirim.

### 2. P1 — Snapshot v1 yang sah dapat dipasangkan dengan katalog v3 dan menahan resep selamanya

- `apps/api/src/edge/master-sync.ts:253` — Edge menerima snapshot v1, tetapi permintaan katalog pada `:828` selalu memakai protokol 3. Jika header negosiasi snapshot dibuang proxy, resep lintas brand dikirim tanpa master brand yang diperlukan. Kaitkan kemampuan katalog dengan hasil negosiasi master, serta sediakan jalur pemulihan ketika header hilang.
- Skenario: Tenant memiliki brand A/B; edge outlet B baru atau hasil bootstrap lama hanya mempunyai master brand B. Proxy meneruskan query katalog tetapi membuang `x-edge-snapshot-version`. Cloud baru melayani snapshot v1 yang sah dan ditandatangani, tanpa daftar brand; edge menerimanya. Katalog tetap meminta v3 dan menerima resep A. Setiap pull mengulang kegagalan karena master A tidak pernah didatangkan oleh snapshot v1 berikutnya.
- Bukti: Header diminta pada `apps/api/src/edge/master-sync.ts:229`, respons v1 diterima pada `:253`, sedangkan versi katalog diset terpisah pada `:828`. Cloud melebarkan resep pada `apps/api/src/services/edge-catalog-sync.ts:753` ketika protokol >= 3. Pemeriksaan brand di `apps/api/src/services/edge-catalog-apply.ts:1543` melempar `CatalogMissingRefError` jika A belum lokal. `apps/api/src/edge/catalog-puller.ts:99` dan `:101` menahan `menu_items` serta `item_variants` ketika stream resep gagal. Pengulangan master sync tidak menyembuhkan header yang terus dibuang.
- Dampak: Checkpoint resep tidak maju; menu dan varian ikut tertahan. Pada edge baru data menu dapat tidak tersedia; pada edge lama perubahan katalog tidak masuk. Ini berbeda dari cloud lama yang memang menegosiasikan katalog v2 dan tetap membatasi resep ke brand outlet.
- Usul perbaikan: Negosiasikan kapabilitas master dan katalog sebagai pasangan. Sediakan fallback negosiasi master yang tidak bergantung pada header tersebut, atau tolak kombinasi v1/v3 dengan diagnosis jelas dan jalur pemulihan. Sekadar menurunkan katalog ke v2 menghindari macet tetapi belum memenuhi kebutuhan resep lintas brand.
- Usul test: Simulasikan proxy yang membuang hanya header snapshot. Bootstrap B-only, letakkan resep A pada halaman resep awal, lalu jalankan beberapa putaran master/katalog. Buktikan sistem mendeteksi ketidakcocokan dan pulih sampai master A, resep A, menu, serta varian tersimpan; watermark tidak boleh melewati halaman yang gagal. Sertakan pembanding cloud lama v1/v2 dan cloud baru v2/v3.

### 3. P1 — Tenant dengan 201 brand tidak dapat menghasilkan snapshot master v2

- `packages/shared/src/edge/master-sync.ts:160` — Daftar seluruh brand dibatasi `MAX_BRANDS = 200` (`:78`), sementara cloud selalu membaca semua brand tenant. Tenant sah dengan brand ke-201 membuat seluruh snapshot gagal, termasuk master outlet yang sebenarnya kecil. Gunakan pengiriman bertahap yang mendukung jumlah brand tersebut; jangan memotong daftar diam-diam.
- Skenario: Tenant mempunyai 201 brand dan sebuah outlet aktif. Edge meminta snapshot v2. `apps/api/src/services/edge-master-sync.service.ts:172` membaca semua 201 brand tanpa pagination; validasi snapshot gagal dan `:274` melempar `CONFLICT`/HTTP 409. Tidak ditemukan pembatasan 200 saat pembuatan brand yang menjadikan kondisi ini terlarang.
- Dampak: Edge baru gagal bootstrap karena `apps/api/src/edge/bootstrap.ts:342` mewajibkan snapshot master. Edge lama terus gagal memperbarui master; resep pada brand baru yang belum lokal terus mengalami `CATALOG_MISSING_REF`. Kegagalan mencakup snapshot uom, lokasi stok, akun, dan mapping, bukan hanya daftar brand.
- Usul test: Seed tenant dengan tepat 200 lalu 201 brand, tambah resep pada brand terakhir, dan jalankan snapshot v2, bootstrap edge baru, serta master/katalog pada edge lama. Semua brand yang dibutuhkan harus sampai dan resep dapat diterapkan. Seed tenant kedua untuk memastikan pagination atau perubahan batas tidak membawa brand tenant lain.

## Hasil pemeriksaan lain dan batas kompatibilitas

- Placeholder: Penggantian katalog menyimpan salinan dead letter dan memasang notice pada `link_seq` yang sama (`apps/api/src/services/edge-queue.service.ts:150` sampai `:195`); notice tidak membawa isi katalog brand lama. Receipt dan cursor diterapkan dalam satu transaksi. Tidak ditemukan cacat tambahan konkret berupa slot bolong/dipakai ulang atau event `panic_alert`, `qr_order`, dan `wifi_quota` tergeser pada jalur placeholder yang diperiksa.
- ACK/reconnect: ACK mengunci cursor dan menandai slot yang sama; hello menggunakan cursor kumulatif. Tidak ditemukan skenario tambahan konkret hilang/ganda pada penggantian placeholder dan ACK terlambat. Kesimpulan ini hasil pembacaan, bukan bukti eksekusi konkuren.
- Edge lama/cloud baru: Edge tanpa applier placeholder tetap menolak batch dan menahan alarm/QR/Wi-Fi di belakangnya. Ini batas yang sudah diakui, bukan temuan baru: `docs/deployment.md:428`–`:429` mewajibkan edge lebih dulu untuk rilis placeholder dan mengatur pengecualian rilis pertama. Peringatan `onHello` tidak mencegah macet; versi `dev` tidak memicu peringatan. Image harus memakai versi semver >= 0.2.0 dan benar-benar memuat applier. Urutan rilis perlu dilaksanakan sebagai gerbang operasional.
- Edge baru/cloud lama: Schema master menerima v1; katalog menegosiasikan versi lama. Tidak ditemukan kebocoran tambahan pada pasangan ini. Kehilangan header pada cloud baru adalah kasus berbeda, dibahas pada temuan 2.
- Integrasi publisher/resep: Publisher tidak mengisi `protocolVersion`, sehingga scanner hasil gabungan tetap membatasi resep yang dikirim melalui link ke brand outlet; applier link juga mengecek brand outlet. HTTP v3 menjadi jalur pemulihan resep lintas brand. Ini tidak dihitung sebagai temuan macet tersendiri ketika HTTP dan snapshot v2 bekerja normal. Hasil merge kedua cabang belum dieksekusi.
- Migrasi 0377 setelah 0374: Cabang edge mereset `sync_txid` tiga tabel dengan bypass trigger, mengosongkan hanya watermark tiga stream, dan mempertahankan `last_success_at` (`apps/api/drizzle/0377_recipes_resync_edges.sql:58`–`:64`). Ini mengatasi stamp lokal yang lebih tinggi dari cloud dan link resep yang dinolkan 0374. Test sumber `apps/api/src/test/recipes-resync-migration-0377-edge.test.ts:387` mencakup pemulihan link; `:416` mencakup freshness yang dipertahankan. Tidak ditemukan cacat baru konkret pada jalur ini; test tersebut belum dijalankan pada audit ini.
- Guard `modifiers_recipe_fk`: Boot menolak constraint yang tidak semestinya ada pada edge (`apps/api/src/edge/runtime.ts:538`). Ini fail-closed dan memerlukan reprovision bila migrasi dijalankan tanpa mode edge; tidak ada drop constraint otomatis.
- Isolasi tenant: Scanner resep dan snapshot brand memfilter tenant, schema memeriksa scope, dan upsert brand menolak benturan ID tenant lain. Tidak ditemukan temuan lintas tenant P0 pada diff yang diperiksa. Ini tidak menyatakan seluruh sistem bebas kebocoran.

## Verifikasi dan tindak lanjut

- Pemeriksaan statis saja; tidak menjalankan test, heavy, build, dev server, migrasi, maupun layanan. Usul test di atas belum ditulis atau dijalankan. Tidak ada klaim gate lulus atau reproduksi database telah dilakukan.
- Hanya laporan ini ditambahkan di worktree `legend-657fbb3c`; kode produk dan folder checkout utama tidak diubah. Tidak merge, push, atau menghapus apa pun.
- Tiga P1 perlu ditangani dan dibuktikan dengan test terarah sebelum gerbang rilis area ini. Penetapan kartu Beads dan pekerjaan perbaikan diserahkan kepada CTO sesuai batas peran Codex.
