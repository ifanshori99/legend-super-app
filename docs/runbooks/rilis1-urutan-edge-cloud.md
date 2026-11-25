# Rilis 1: urutan edge dan cloud, dan cek push alarm (legend-ir8n8, legend-zn3wl, legend-ofq4f)

Runbook ini untuk operator rilis. Isinya satu tempat untuk menjawab "edge dulu atau cloud dulu?" pada rilis pertama dan upgrade berikutnya, ditambah daftar cek push alarm sebelum rilis.

Dua aturan urutan yang berlawanan, keduanya benar untuk perubahan yang berbeda:

| Perubahan                                                                                         | Kartu                      | Urutan                        | Alasan                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Record sync membawa field `sharedMode`                                                            | legend-ir8n8               | **Edge dulu, cloud kemudian** | Edge lama dengan skema strict diduga menolak record sync yang membawa field `sharedMode`. Perilaku edge lama untuk field ini belum diverifikasi. |
| Katalog edge: `syncTxid` dan kursor `cat2`, atau event `catalog_record.updated` dengan field baru | legend-zn3wl, legend-dciax | **Cloud dulu, edge kemudian** | Edge baru menolak record katalog tanpa `syncTxid`. Edge lama menolak (strict) event `catalog_record.updated` berfield baru dari cloud.           |

Gerbang rilis 1 (`predeploy-check`, drift migrasi) hanya melindungi database cloud. Edge hanya menjalankan `migrate.js` (`deploy/edge/README.md`, bagian "Database migrations"), jadi gerbang data dan cek drift ini **tidak** melindungi database edge.

Rincian katalog (gejala, cek `syncTxid`, rollback) ada di `docs/runbooks/edge-catalog-deploy-order.md`. Jangan diduplikasi di sini.

Perilaku edge lama terhadap event katalog dan field `sharedMode` belum diverifikasi. Gejala bila edge lama tidak bisa mengklasifikasi sebuah event: seluruh batch ditolak (lihat "Edge host" di `docs/deployment.md`, urutan placeholder antrean), sehingga event di belakangnya, termasuk `panic_alert`, macet. Rollback: naikkan edge ke versi rilis di jendela rilis yang sama; jangan menunggu rilis berikutnya. Untuk legend-zn3wl: edge dinaikkan di jendela yang sama, segera setelah cloud.

## Instalasi pertama

Sebelum langkah 1: data shower wajib nol, lihat `docs/runbooks/rilis1-shower-nol-data.md` (1269 F0).

Build edge dan cloud yang sama, dari commit rilis yang sama. Belum ada edge lama di lapangan dan belum ada katalog tersinkron di edge, jadi tidak ada pihak yang menolak record dari pihak lain. Urutan:

1. Cloud: jalankan pre-deploy check dan migrasi (`docs/deployment.md`, bagian "Gerbang rilis 1"), lalu naikkan API, web, dan worker.
2. Edge outlet percobaan dengan image yang sama, lalu outlet lain satu per satu setelah sync outlet percobaan sehat.
3. Selesaikan daftar cek push alarm di bawah sebelum alarm panik dianggap aktif.

Catatan: pada instalasi pertama, jangan memindahkan brand outlet sebelum semua edge berversi `EDGE_NODE_VERSION` >= `EDGE_LINK_PLACEHOLDER_MIN_VERSION` (lihat bagian "Edge host" di `docs/deployment.md`, legend-3k41y).

## Upgrade berikutnya (sudah ada edge di lapangan)

Tentukan dulu perubahan apa yang dibawa rilis, dari diff `apps/api` dan `packages/shared/src/edge` terhadap rilis sebelumnya.

| Rilis membawa                                                                            | Urutan                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perubahan `sharedMode` saja                                                              | Edge dulu, lalu cloud.                                                                                                                                                                                                                                   |
| Perubahan katalog edge saja (`syncTxid`, `cat2`, field baru di `catalog_record.updated`) | Cloud dulu, lalu edge. Ikuti `edge-catalog-deploy-order.md`.                                                                                                                                                                                             |
| Keduanya sekaligus                                                                       | Pecah jadi dua rilis berurutan: rilis `sharedMode` (edge, lalu cloud) selesai penuh, baru rilis katalog (cloud, lalu edge). Satu rilis tidak bisa memenuhi dua urutan yang berlawanan. Bila tidak bisa dipecah, bawa keputusannya ke CTO sebelum deploy. |
| Placeholder antrean `edge_link.dead_lettered` (legend-3k41y)                             | Edge dulu, lalu cloud. Lihat "Edge host" di `docs/deployment.md`.                                                                                                                                                                                        |
| Tidak menyentuh sync edge                                                                | Cloud dulu, karena migrasi dijalankan di cloud.                                                                                                                                                                                                          |

Bila ragu apa yang dibawa rilis, anggap perubahan itu ada dan tanyakan CTO. Salah urutan tidak menghilangkan data (checkpoint tidak maju, edge memakai data terakhir yang sudah tersinkron), tetapi sync edge berhenti sampai sisi yang tertinggal dinaikkan, dan harga atau katalog lama bertahan selama itu.

### Cek setelah tiap langkah

- Edge: sync tidak lagi melaporkan penolakan record dan checkpoint di `edge_pull_checkpoints` bergerak maju.
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
