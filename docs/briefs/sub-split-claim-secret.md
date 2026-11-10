# Rahasia pembayar untuk token klaim bagian split (legend-r77pq)

Status: desain, 10 Nov 2026. Basis: `ws/ec6fa-claim-race` (cc4e06f9, opsi 2). Menutup temuan architect atas cc4e06f9 dan Codex 380 P1#2.

## Masalah
Semua tamu satu meja memegang satu kredensial sesi. Id bagian (`splitId`) terlihat oleh seluruh meja. `createGuestPayment` (`qr-order-payment.ts:392-437`) mengembalikan intent bagian (termasuk `id`) ke tamu mana pun, jadi `paymentId` tidak bisa jadi bukti pembayar: tamu B memanggil create untuk bagian A, menerima id intent A, lalu mengambil token klaim A.

## Keputusan
Bukti kepemilikan = **rahasia pembayar** per bagian, bukan id intent.

1. Rahasia dibuat oleh **klien pembayar** (acak 32 byte, `ps_` + base64url 43 karakter, mirip token klaim), dikirim pada permintaan membuat pembayaran bagian. Server menyimpan hanya `sha256` (hex) di `bill_splits.payer_secret_hash`. Server tidak pernah mengembalikan atau menyimpan rahasia mentah.
   - Selisih dari catatan CTO ("server membuat dan mengembalikan"): rahasia buatan klien tidak ikut terekam di respons yang diputar ulang oleh `qrOrderIdempotent`, dan tetap benar bila respons pertama hilang di jaringan. Keamanan sama: 256 bit acak, hanya hash di DB.
2. `createGuestPayment`, target bagian:
   - `payerSecret` wajib.
   - Bagian belum punya hash: pembuat intent pertama menjadi pembayar; hash disimpan di transaksi yang sama dengan intent.
   - Hash ada dan cocok (banding hash, `timingSafeEqual`): pembayar. Perilaku seperti sekarang (ulang, intent pending, intent paid).
   - Hash ada dan tidak cocok:
     - bagian sudah `paid`: 409 `SPLIT_PART_PAID`, tanpa intent atau id.
     - kode masih hidup (pending, belum lewat masa tunggu): 409 `SPLIT_CODE_ACTIVE`, tanpa intent atau id.
     - kode lama sudah mati (expired dan lewat masa tunggu, `partLiveCodeTx` kosong): intent baru dibuat dan hash diganti ke rahasia pemanggil (ambil alih; tidak mengunci bagian selamanya bila pembayar pertama kehilangan rahasia).
   - Tamu lain hanya mendapat status bagian dari `/bill` (yang sudah ada), tidak ada intent.
3. `getSplitClaim` (`GET .../splits/:splitId/claim`): query `paymentId` diganti rahasia pembayar. Satu query: bagian di sesi ini DAN `payer_secret_hash = sha256(secret)`. Salah, tidak ada, atau bukan milik: `NOT_FOUND` yang sama. Rahasia dikirim lewat header `X-Payer-Secret` bila `defineEndpoint` mendukung header, bila tidak lewat `POST` body (bukan query, agar tidak masuk log URL).
4. `getGuestPayment` tidak berubah: id intent kini hanya dikembalikan ke pembayar yang membuatnya, jadi id itu sendiri tidak bocor lagi.
5. Opsi 2 (sudah di cabang dasar): hanya intent `= bill_splits.payment_intent_id` berstatus paid yang dihitung bukti. Dengan rahasia, cek ini tetap dipertahankan: token klaim hanya untuk bagian `paid`.

## Data
- Migrasi `0255` (`ALTER TABLE bill_splits ADD COLUMN payer_secret_hash varchar(64)`), nullable. Bagian lama tanpa hash: tidak bisa membuka token klaim lewat endpoint ini; masih bisa lewat token (`getSplitClaimByToken`) yang sudah dipegang. Tanpa backfill.
- Tanpa CHECK (tabel FORCE RLS; format dijaga zod dan hash dibuat server).

## Web
- Klien yang membayar bagian membuat rahasia, menyimpan di `sessionStorage` (kunci per `sessionId` + `splitId`, dibungkus try/catch), dan mengirimnya pada `startPayment`.
- Tersedia fungsi api + hook untuk mengambil token klaim bagian dengan rahasia itu. Tombol klaim di UI memakainya; tidak ada layar baru di slice ini.

## Di luar scope
- Pembayaran seluruh pesanan (bukan bagian): tidak berubah.
- Kedaluwarsa klaim: tetap 24 jam sejak bayar (by design).
