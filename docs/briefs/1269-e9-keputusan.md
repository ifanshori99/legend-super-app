# E9 proksi bayar QRIS edge lewat cloud: keputusan CTO (27 Nov)

Bead legend-osqou.30. Rancangan architect 26 Nov (Opus, baca kode saja), diterima CTO dengan tambahan di bawah. Dasar: founder no. 30, prinsip "jangan sampai rugi".

## Prinsip
- Kasir edge tidak pernah menandai lunas tanpa bukti cloud. Cloud satu-satunya pemanggil gateway. Ragu = jalur refund dengan approval. Tidak ada tombol "tandai lunas" manual.
- Semua di balik saklar, mati bawaan. Saklar mati = QRIS di edge terkunci, tidak ada panggilan provider dari edge.

## 1. Catatan cloud
Pakai `payment_links`/`payment_intents` + `createPaymentLink`/`createIntent` yang sama dengan QRIS kasir cloud. Tabel pengikat baru `edge_payment_proxies` (migrasi nomor sementara, dinomori ulang saat merge):
tenant, outlet, node, command_id (unik), edge_order_id, nomor order, purpose=`sale_remainder`, attempt, amount, state, link_id (unik), intent_id (unik), qr, expires_at. Unik (tenant, edge_order_id, purpose, attempt) + unik parsial satu yang hidup per edge_order_id. RLS tenant+outlet di `.custom.sql`. `intents.order_id` NULL sampai ingest.

## 2. Lunas sampai ke edge
Kirim lewat kind F1 `payment.qris_open` (`succeeded` = permintaan tercatat, bukan lunas). Status ditarik `GET /edge/payment-proxies/:id` lewat `cloudGetJsonConditional`: 2 dtk saat layar terbuka, 15 dtk di latar, semua yang terbuka saat boot. Tender edge `authorized` + hold lokal; `captured` hanya bila pull membawa `paid` dan nominal intent = tender, satu transaksi lokal.

## 3. Telat dan ganda
- Hold tutup hanya oleh bukti cloud (`paid` atau `expired` final provider).
- Online: rilis manajer = `payment.qris_release`; handler kunci baris proksi: belum dibayar `released`, sudah dibayar `already_paid` (edge terima sebagai lunas).
- Putus: rilis lokal PIN manajer hanya sesudah QR kedaluwarsa + jeda Q93; perintah diantre; ternyata sudah dibayar = cloud `refund_filed`.
- `paid` sesudah rilis: permintaan refund ala `pos-order-late-payment.ts`, kunci `edge-proxy-late-refund:<intentId>`, approval WS-05.
- Bayar kedua: jalur dana tak teralokasi (gz3). Consumer baru di `order-payment-consumers.ts` sebelum cabang POS.
- Proksi `paid` tidak terpakai > 48 jam: kasus rekonsiliasi.

## 4. Ingest
Tender QRIS edge wajib `proxyId`. `edge/order-ingest.ts` kunci proksi, cek order sama, outlet sama, state `paid`, nominal sama, belum terpakai; isi `payment_link_id`/`payment_intent_id` dan `intents.order_id`, state `consumed`. Jurnal receipt-first: `payment.paid` ke customer_deposit, `order.paid` memindahkan keluar. Tender gateway tanpa proksi ditolak `tender_unsupported`.

## 5. Provider
Handler tulis proksi `requested` + outbox satu transaksi. Worker sesudah commit `createIntent` kunci `edge-proxy:<proxyId>` (<= 50 char, batas Duitku), isi `issued` + QR. Gagal final `failed`, edge buat attempt baru.

## 6. Metode
QRIS saja. VA dan e-wallet push tetap terkunci (E10).

## 7. D-09
Hapus cabang D-09 (`pos-order-payment.ts:496`, `pos-payment-options.service.ts:50`). Kredensial gateway tidak pernah turun ke edge.

## Tambahan CTO
- Plafon nominal: cloud menolak proksi dengan nominal <= 0 atau di atas plafon QRIS per outlet. Pakai plafon yang sudah ada bila ada; bila belum ada, setelan cloud baru dengan bawaan Rp 2.000.000 per transaksi (paling ketat, bisa dinaikkan owner nanti) dan laporkan.
- Urutan kartu: E9a cloud dulu, lalu E9b ingest dan E9c edge. Satu engineer berurutan (slot edit penuh). Review K architect xhigh per kartu atau gabungan E9a+b+c sebelum merge, satu kali.

## Test wajib
Balasan hilang tiap hop/retry/crash worker = satu intent satu capture; rilis vs `paid` balapan dua arah, tepat satu menang, `paid` sesudah rilis = satu permintaan refund; event ganda/terbalik `payment.paid`/`expired` aman; ingest replay = satu tender satu jurnal, proksi untuk dua order ditolak, nominal beda ditolak, tanpa proksi ditolak; customer_deposit kembali nol, clearing tidak dobel; edge putus tidak pernah lunas, rilis lokal hanya sesudah kedaluwarsa + jeda; saklar mati = QRIS ditolak tanpa panggilan provider; nominal di atas plafon ditolak; outlet lain 403/404.

## Risiko diterima
Selama putus, tamu yang sudah bayar menunggu sampai cloud tersambung (lebih aman daripada lunas tanpa bukti).

## Keputusan CTO tambahan 27 Nov
- §5: baris proksi `requested` sendiri menjadi antrean worker (tanpa event outbox baru). Diterima: tahan crash sama, worker mengambil `requested` dengan kunci baris (`FOR UPDATE SKIP LOCKED`), kunci idempoten provider `edge-proxy:<proxyId>` tetap.
- Plafon: tabel plafon per outlet baru, bawaan Rp 2.000.000. Saklar `EDGE_PAYMENT_PROXY_ENABLED` mati bawaan. Migrasi sementara 0534.
