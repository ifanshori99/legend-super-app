# Rilis 1: urutan edge dan cloud, dan cek push alarm (legend-ir8n8, legend-zn3wl, legend-ofq4f)

Runbook ini untuk operator rilis. Isinya satu tempat untuk menjawab "edge dulu atau cloud dulu?" pada rilis pertama dan upgrade berikutnya, ditambah daftar cek push alarm sebelum rilis.

Urutan mengikuti kontrak yang berubah. Penambahan field event katalog berbeda dari pengenalan protokol pull HTTP:

| Perubahan                                              | Kartu        | Urutan                        | Alasan                                                                                                                                                         |
| ------------------------------------------------------ | ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record sync membawa field `sharedMode`                 | legend-ir8n8 | **Edge dulu, cloud kemudian** | Kemampuan edge menerima field baru harus dibuktikan sebelum cloud mulai mengirimnya; versi yang belum terbukti memblok rilis.                                  |
| Event `catalog_record.updated` membawa field baru      | legend-zn3wl | **Edge dulu, cloud kemudian** | Record event memakai skema strict (`packages/shared/src/edge/catalog-record-event.ts`); toleransi field baru pada snapshot/pull HTTP tidak berlaku pada event. |
| Pengenalan `syncTxid` dan kursor `cat2` pada pull HTTP | legend-dciax | **Cloud dulu, edge kemudian** | Edge baru menolak record pull tanpa `syncTxid`; ini prasyarat protokol HTTP, bukan izin mengirim field event baru ke edge lama.                                |

Gerbang rilis 1 (`predeploy-check`, drift migrasi) hanya melindungi database cloud. Edge hanya menjalankan `migrate.js` (`deploy/edge/README.md`, bagian "Database migrations"), jadi gerbang data dan cek drift ini **tidak** melindungi database edge.

Rincian katalog (gejala, cek `syncTxid`, rollback) ada di `docs/runbooks/edge-catalog-deploy-order.md`. Jangan diduplikasi di sini.

Gejala bila edge lama menolak record atau tidak bisa mengklasifikasi sebuah event: seluruh batch ditolak (lihat "Edge host" di `docs/deployment.md`, urutan placeholder antrean), sehingga event di belakangnya, termasuk `panic_alert`, macet. Jangan menggunakan cloud yang mengirim field event baru sebelum semua penerima siap. Bila sudah terlanjur, hentikan rollout cloud dan pulihkan pasangan versi yang kompatibel; jangan menghapus event atau memajukan checkpoint untuk meloloskan antrean.

## Instalasi pertama

Build edge dan cloud yang sama, dari commit rilis yang sama. Belum ada edge lama di lapangan dan belum ada katalog tersinkron di edge, jadi tidak ada pihak yang menolak record dari pihak lain. Urutan:

1. Cloud: jalankan pre-deploy check dan migrasi (`docs/deployment.md`, bagian "Gerbang rilis 1"), lalu naikkan API, web, dan worker.
2. Edge outlet percobaan dengan image yang sama, lalu outlet lain satu per satu setelah sync outlet percobaan sehat.
3. Selesaikan daftar cek push alarm di bawah sebelum alarm panik dianggap aktif.

Catatan: pada instalasi pertama, jangan memindahkan brand outlet sebelum semua edge berversi `EDGE_NODE_VERSION` >= `EDGE_LINK_PLACEHOLDER_MIN_VERSION` (lihat bagian "Edge host" di `docs/deployment.md`, legend-3k41y).

## Upgrade berikutnya (sudah ada edge di lapangan)

Tentukan dulu perubahan apa yang dibawa rilis, dari diff `apps/api` dan `packages/shared/src/edge` terhadap rilis sebelumnya.

| Rilis membawa                                                | Urutan                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perubahan `sharedMode` saja                                  | Edge dulu, lalu cloud.                                                                                                                                                                                                                                                                                                    |
| Field baru di event `catalog_record.updated`                 | Edge dulu, lalu cloud, setelah gerbang kompatibilitas di bawah lulus.                                                                                                                                                                                                                                                     |
| Pengenalan pull HTTP `syncTxid` / `cat2` saja                | Cloud dulu, lalu edge. Ikuti `edge-catalog-deploy-order.md`.                                                                                                                                                                                                                                                              |
| Perubahan field event dan prasyarat cloud sekaligus          | Pisahkan menjadi tahap kompatibilitas: cloud menerima kontrak edge baru dan menyediakan skema/protokol yang dibutuhkan, tetapi belum mengirim field event baru; naikkan semua edge; baru aktifkan pengiriman cloud baru. Jika tidak ada build perantara yang memenuhi keduanya, **BLOCK** dan bawa ke CTO sebelum deploy. |
| Placeholder antrean `edge_link.dead_lettered` (legend-3k41y) | Edge dulu, lalu cloud. Lihat "Edge host" di `docs/deployment.md`.                                                                                                                                                                                                                                                         |
| Tidak menyentuh sync edge                                    | Cloud dulu, karena migrasi dijalankan di cloud.                                                                                                                                                                                                                                                                           |

Bila ragu apa yang dibawa rilis, anggap perubahan itu ada dan tanyakan CTO. Salah urutan tidak menghilangkan data (checkpoint tidak maju, edge memakai data terakhir yang sudah tersinkron), tetapi sync edge berhenti sampai sisi yang tertinggal dinaikkan, dan harga atau katalog lama bertahan selama itu.

### Gerbang kompatibilitas wajib (legend-ir8n8, legend-zn3wl)

Gerbang ini pemeriksaan operator yang **memblok rilis**, melengkapi gerbang SQL cloud. `edge_nodes.version` adalah string yang dilaporkan heartbeat, bukan bukti isi image; `0.2.0`, versi lebih besar, `dev`, atau SHA yang tidak dipetakan ke build terverifikasi tidak otomatis lolos.

Gunakan query inventaris read-only pada bagian gerbang kompatibilitas edge di `docs/deployment.md`, dengan koneksi operator migrasi yang dapat melihat seluruh node, bukan login aplikasi yang dibatasi RLS. Jangan menafsirkan error tabel/kolom sebagai inventaris kosong; kolom hilang memblok pemeriksaan. N/A hanya jika tabel `edge_nodes` benar-benar belum ada. Inventaris yang berhasil dijalankan tanpa node aktif berarti lolos.

1. Inventaris semua `edge_nodes` berstatus `active`, termasuk primary, standby, dan node offline. Tidak adanya heartbeat baru tidak membuat sebuah node tidak aktif. Nol node aktif membuat gerbang ini lolos; catat hasil inventarisnya.
2. Catat commit dan digest image cloud yang akan dirilis serta image edge penerimanya. Buktikan pada pasangan build itu bahwa edge menerima record `sharedMode` dan setiap stream event `catalog_record.updated` yang bentuknya berubah, tanpa penolakan skema strict. Gunakan data uji; jangan memakai token atau isi event produksi dalam bukti.
3. Periksa prasyarat cloud sebelum menaikkan edge: migrasi yang dibutuhkan edge sudah tersedia, cloud menerima payload heartbeat baru, dan protokol pull HTTP sudah kompatibel. Bila upgrade edge membutuhkan cloud baru yang langsung mengirim field event belum didukung edge lama, **BLOCK** sampai build perantara tersedia; jangan membalik urutan secara global.
4. Naikkan edge outlet percobaan ke image terverifikasi, lalu semua node aktif lainnya. Cocokkan digest/commit image yang benar-benar berjalan dan heartbeat versi yang masuk **setelah restart**. Periksa sync dan checkpoint pada node percobaan sebelum melanjutkan.
5. **BLOCK** bila ada satu node aktif yang masih lama, offline sehingga upgrade belum terbukti, versinya tidak dikenal, digest/commit tidak cocok, atau penerimaan record/event belum terbukti. Resolve: upgrade node dan ulangi bukti; node yang benar-benar dipensiunkan harus dicabut melalui alur operasional yang sah, bukan sekadar diabaikan dalam inventaris.
6. Simpan bukti per node (id, role, versi, digest/commit, waktu heartbeat setelah restart, hasil sync) bersama catatan rilis. Baru setelah semua node aktif lulus, lanjutkan rollout cloud yang mengirim field baru. Jangan downgrade edge selama cloud masih mengirim field tersebut.

### Cek setelah tiap langkah

- Edge: sync tidak lagi melaporkan penolakan record. Untuk pull HTTP, checkpoint `edge_pull_checkpoints` pada stream yang diuji bergerak maju. Untuk event `catalog_record.updated`, periksa receipt `edge_inbound_events` dengan `outcome = 'applied'` dan `sync_cursors.received_in_seq` pada arah `cloud_to_edge`, serta nilai field baru di record lokal, sesuai gerbang event strict di `docs/deployment.md`; keberhasilan pull HTTP tidak membuktikan penerimaan event link.
- Cloud: `curl` ke `/api/edge-sync/catalog?stream=stations&limit=1` mengembalikan `syncTxid` berupa string angka (perintah lengkap di `edge-catalog-deploy-order.md`).
- Satu outlet percobaan sehat sebelum outlet lain dinaikkan.

## Daftar cek push alarm (legend-ofq4f)

Kode push alarm panik sudah selesai (`docs/qa/ofq4f-push-registration.md`). Yang tersisa adalah gerbang rilis yang hanya bisa dibuktikan di server produksi dan ponsel nyata. Kartu `legend-ofq4f` tetap terbuka sampai semua butir ini tercentang.

Env di server:

- [ ] `NOTIFICATION_PUSH_PROVIDER=web_push` terisi di `api.env` **dan** `worker.env`.
- [ ] `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, dan `VAPID_SUBJECT` terisi dan sama di API dan worker, sesuai bagian VAPID ("Web push") di `docs/deployment.md` (pembuatan kunci, rotasi, dan larangan mencetak nilai ada di sana).
- [ ] API dan worker sudah restart setelah env diisi. Validasi env menolak start bila `web_push` dipilih tetapi salah satu dari tiga nilai VAPID kosong atau public key bukan P-256 base64url 65 byte.
- [ ] Kebijakan tenant menyalakan web push untuk outlet yang diuji (API hanya memberi public key bila provider dan kebijakan tenant sama-sama menyala).

Uji di ponsel nyata (emulator tidak cukup):

- [ ] Android: aktifkan push di browser, kunci HP, diamkan lebih dari 30 menit, picu alarm panik uji. Push harus sampai.
- [ ] iOS (16.4 ke atas): pasang aplikasi ke layar utama sebagai PWA, aktifkan push dari PWA itu. Push dari tab Safari biasa tidak berlaku.
- [ ] Ganti PIN darurat dengan token perangkat asli (tombol "Pakai di perangkat ini"), lalu pastikan kembali ke layar fasilitas yang sama.
- [ ] Izin notifikasi ditolak atau dicabut dari pengaturan HP: alarm tetap muncul in-app, tidak ada error di worker.
- [ ] Keluar (sign-out) mencabut push perangkat itu: alarm berikutnya tidak masuk ke perangkat tersebut.

Catat hasil (tanggal, perangkat, lulus atau gagal) di `bd comment legend-ofq4f`. Jangan menutup kartu dari uji di emulator.
