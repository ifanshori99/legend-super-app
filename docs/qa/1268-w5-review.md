# Review W5 (ws/1268-w5 49101364a vs b268e4c24)

Read-only review. Tests, typecheck and the UI script were NOT run. Only isi-1280 and detail-390 were viewed of the 10 screenshots.

## Temuan
1. P2 akses captain/waiter. Guard `/pos/pesanan` dan detail = `pos.sale.create | pos.payment.accept | pos.void.request`
   (ws04-pos-open-orders/guard.ts, ws04-pos-order-detail/guard.ts). Role waiter (roles.ts ~l.365-376) hanya punya
   `order.view` + `order.create`, `pos.payment.accept` opsional. Server menerima fire lewat `sellOrCaptain`
   (pos-order.routes.ts:302, fallback `order.create`) dan list lewat `order.view`.
   Skenario: waiter tanpa payment.accept membuka /pos/pesanan -> notFound, padahal API mengizinkan.
   Kebalikannya: peran hanya `pos.payment.accept` atau `pos.void.request` melihat tombol "Kirim ke dapur"
   (canFire hanya cek status dan jumlah held, bukan izin) -> 403 dari server.
   Tombol "Lanjut ke pembayaran" juga tampil tanpa `pos.payment.accept` (route bayar -> notFound).
   Saran: guard memakai `order.view`, tombol fire butuh `pos.sale.create | order.create`, tombol bayar butuh `pos.payment.accept`.
2. P3 order `draft` ada di daftar (OPEN_ORDER_STATUSES) tapi PrimaryAction (order-actions.tsx) tetap menampilkan
   bayar untuk draft. Belum diverifikasi apakah layar bayar menangani draft (submit dulu); jika tidak, jalan buntu.
3. P3 detail memanggil `useOpenOrders()` (sampai 10 halaman, polling 20 dtk) hanya untuk cek link lama.
   Daftar basi yang lebih kecil dari detail memunculkan peringatan "link lama" palsu bila total detail naik.
4. P3 `primitiveQuery` (endpoint-core.ts) kini menerima semua array string untuk endpoint mana pun (dulu throw).
   Nilai berasal dari hasil parse zod, jadi tidak membuka filter lain: OK. Elemen yang mengandung koma jadi ambigu, belum ada contoh.

## Sudah benar (dari kode)
- Kirim ke dapur: `fireItems` memakai kunci + ids terurut + expectedStatus yang disimpan sebelum kirim; ulang = bytes sama
  (tes "lost reply" ada). Slot sessionStorage sama dengan captain. Conflict -> FIRE_INTENT_PENDING; layar terkunci di "Periksa lagi".
- Sisa tagihan: diambil dari server (`remainingIdr`), partlyPaid = remaining < total; tidak dihitung ulang di klien.
- Pesanan ditahan (parked): row tanpa field harga (tes memeriksa key); "Lanjutkan" membuka sheet lewat ?ditahan=1 lalu dihapus dari URL.
- Filter status: draft,awaiting_payment,sent dikirim sebagai comma list; final order disaring lagi di klien.
- UI isi-1280 dan detail-390: sesuai ui-standard (kontras, target besar, pill ikon+teks, bar aksi bawah di mobile). Tidak ada cacat terlihat.

## Keputusan CTO 26 Nov
- No. 1: `/pos/pesanan` layar kasir; waiter/captain tetap pakai layar captain (W4). Guard tetap, tapi tulis alasannya di guard dan test bahwa waiter diarahkan ke captain, bukan notFound kosong.
- No. 2: tombol per izin: "Kirim ke dapur" hanya bila izin fire (sama dengan route server); "Lanjut ke pembayaran" hanya bila `pos.payment.accept`. Test.
- No. 3: order `draft`: tanpa tombol bayar, tampilkan "Lanjutkan di kasir".
- No. 4: peringatan tautan lama hanya bila daftar segar (< 20 detik); selain itu sembunyikan.

## Re-review (delta 49101364a..750a48f14, 750a48f14)
Hasil: LULUS (tanpa temuan P1/P2). Hanya baca kode delta; tes/typecheck tidak dijalankan.
- No. 1 OK: `openOrdersGate` mengarahkan akun `order.create` tanpa izin kasir ke `/pos/captain` (redirect), selain itu notFound; alasan ditulis di guard.ts. Akun yang punya `pos.payment.accept` tetap masuk.
- No. 2 OK: `orderActionRights` meniru server (fire = `pos.sale.create | order.create`, bayar = `pos.payment.accept`). `primaryActionOf` murni dan diuji. SecondaryPay juga butuh `rights.pay`. Akses tidak terbaca -> semua tombol disembunyikan (gagal tertutup).
- No. 3 OK dengan catatan: draft tidak lagi punya tombol bayar; diganti "Lanjutkan di kasir" (hanya `pos.sale.create`). Catatan P3: tautan ke `/pos/kasir` polos, tanpa id draft; belum terlihat kasir melanjutkan draft itu (continueDraft hanya ada di layar captain).
- No. 4 OK dengan catatan P3: `oldLinkRemainingIdr` menolak daftar >= 20 dtk. Namun `useNow` tick tiap 5 dtk, jadi setelah tiap refetch `dataUpdatedAt` bisa > `now` -> umur negatif -> peringatan tersembunyi sampai tick berikut (maks 5 dtk), muncul-hilang tiap 20 dtk. Perbaikan kecil: umur = `Math.max(0, now - dataUpdatedAt)` atau `Date.now()` saat render. Tombol bayar tidak terpengaruh.
