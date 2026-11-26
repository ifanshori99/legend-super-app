# Review K O3 tablet offline (ws/1272-o3 5f50a733b)

Reviewer: architect (Opus), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 1 P1, 4 P2, 3 P3. Re-review diff perbaikan saja.

## Aman
- Nomor L + antrean satu transaksi IDB `strict` (`queue.ts:210-247`); eventId dibuat sekali, disimpan.
- Harga dari bekal, diskon 0 (`price.ts:180-183`).
- SW tidak menyentuh API, server fn, non-GET. IDB tidak terhapus logout/update SW.

## P1
`queue.ts:15-17,277-288`: sale 409 yang disisihkan tidak menahan tutup shift. Cloud menyimpan sale lain (kit lain), bukan sale ini: tunai tidak tercatat dan bisa hilang dari laci; sale di tengah membuat sale berikutnya `sequence_gap` selamanya (`pos-offline-batch.service.ts:375-378`). Test `pos-offline-queue.test.ts:486-503` menegaskan perilaku salah. `queue.ts:70-73` cocok ke kode generik `CONFLICT` (juga tolakan edge, `service.ts:160-165`).

## P2
1. `pos-shift.service.ts:1355`, `schemas.ts:1283`: tanpa jumlah antrean, atau dari perangkat lain, tutup shift lolos.
2. `sw.js:20-33`: SW cache semua `/pos/*` termasuk detail pesanan dan shift supervisor, abaikan `no-store`; HTML memuat sesi Better Auth (`__root.tsx:78`); tanpa batas entri. `shell.ts:22` pakai `postMessage`.
3. `sign-out-button.tsx:32`: logout tidak ditolak saat antrean belum kosong.
4. `shift-api.ts:470`, `queue.ts:211-215`: bekal tetap berlaku sesudah tutup shift.

## P3
- `hooks.ts:80-81`: `ensureKit` gagal melewatkan sinkron tick itu.
- `queue.ts:160-171`: sesudah `rejected`, batch berikut tetap dikirim (alert celah palsu).
- `cashier-main-screen.tsx:77`: hook sinkron hanya di layar kasir; `/pos/shift/tutup` tidak menyinkron.

## Keputusan CTO 27 Nov
Prinsip: uang tunai offline tidak boleh hilang dari catatan, dan kafe tidak boleh terkunci tanpa jalan keluar.

1. **P1**: server memakai kode khusus `OFFLINE_EVENT_CONFLICT`; tablet hanya menyisihkan pada kode itu. Sale disisihkan menahan tutup shift dan logout. Jalan keluar: tablet mengirim laporan konflik (endpoint baru, idempoten per eventId) berisi nominal + item; server mencatatnya seperti sale `shift_closed` (flag `event_conflict`, jurnal ke 1205 clearing, alert supervisor dan Finance), dan slot nomor urut dianggap terisi sehingga sale berikutnya tidak `sequence_gap`. Sesudah laporan diterima, sale itu tidak lagi menahan tutup shift. Test: sale tengah konflik -> laporan -> sale berikutnya masuk, tutup shift lolos, 1205 bertambah nominal itu; laporan ganda = satu baris.
2. **P2 #1**: bila ada `pos_offline_kits` untuk shift, tutup shift wajib membawa jumlah antrean dari perangkat pemegang bekal; selain itu 409 `OFFLINE_QUEUE_UNVERIFIED`. Jalan keluar tablet rusak: tutup paksa supervisor (izin + alasan wajib) menandai shift `offline_queue_unverified` dan alert Finance; batch yang datang belakangan masuk jalur `shift_closed`.
3. **P2 #2, #3, #4, P3**: dibetulkan sesuai saran reviewer (cache hanya shell `/pos/kasir` tanpa data sesi, `caches.delete` langsung; logout ditolak saat antrean/disisihkan belum kosong; bekal dibuang sesudah tutup shift dan `recordSale` menolak bekal shift tertutup; `try` terpisah; berhenti kirim sesudah `rejected`; hook sinkron juga di `/pos/shift/tutup`).
4. Migrasi baru (bila perlu) dinomori sesudah 0537 int/rc2.

## Re-review 27 Nov (222161c91): GAGAL ringan
- Tertutup: P1 lama (kode `OFFLINE_EVENT_CONFLICT`, laporan konflik isi nomor + 1205 + alert, ganda = `duplicate`), P2 #1-#4, P3 lama. Laporan konflik hanya dari perangkat outlet + `shift.cash.operate` + kit/perangkat/run sah + nomor L = high-water+1. Tutup paksa: `shift.cash.approve_close`, alasan >= 10 huruf, penyetuju bukan pemanggil/kasir, alert Finance.
- **P1 baru (bukan uang)**: shell `/pos/kasir` tidak pernah ter-cache: fetch tanpa cookie di-redirect guard `_ops` ke `/sign-in` (`lib/areas/route.ts:16`), dan `start.ts:50-59` memasang `no-store`. Reload saat offline = tidak bisa jualan. Fix: route shell publik tanpa data/sesi di luar `_ops`, Cache-Control sendiri; SW cache route itu; test 200 tanpa cookie + HTML tanpa sesi.
- P3: `pos-shift.service.ts` ~:1420 `some` -> semua pemegang bekal harus pemanggil (selain itu tutup paksa supervisor). P3: teks penolakan logout masuk katalog Indonesia.
- Re-review berikut: diff shell + test saja.

## Re-review 2 27 Nov (ae9509d84): LULUS
- Shell `/pos-offline` publik tanpa data/sesi, `private, no-cache`; SW tidak simpan `no-store`/redirect; redirect tetap ke origin sendiri (tidak open-redirect); `caches.delete` saat logout; shell tidak menjual (O4). `every` benar.
- P3 dibetulkan sebelum gabung: fetch shell `credentials: "omit"`, reset `shellFetchedAt` + cache `v2`, teks "terkirim sesudah layar kasir dibuka lagi".
- Belum terbukti di browser nyata: IDB + SW benar-benar melayani shell saat offline (masuk O5 drill).
