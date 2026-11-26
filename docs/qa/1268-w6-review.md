# Review 1268 W6 (ws/1268-w6, 572fec927 vs 12671a186)

Hasil: LULUS (tanpa temuan yang harus dibetulkan). Review baca kode; spec e2e tidak dijalankan.

## "Lanjutkan di kasir" `/pos/kasir?draft=<id>`
- Pesanan tidak dobel: `useContinueCashierDraft` -> `continueDraftOrder` -> `continueDraft` (captain-flow.ts:135). Memakai kunci kirim tersimpan atau kunci `draft:<orderId>` yang dipertahankan sampai dijawab. Tidak pernah memanggil create. Test baru di pos-captain-wire.test.ts membuktikan kunci sama saat balasan hilang. Server menolak kirim ulang dengan `expectedStatus: "draft"` (pos-order.service.ts:1354, 412), jadi klik ganda atau layar basi tidak bisa mengirim dua kali.
- Izin: tombol di detail hanya muncul bila `pos.sale.create` (fire.ts:38, 59). Rute `/pos/kasir` dijaga `pos.sale.create` di `beforeLoad`. API tetap memeriksa ulang. `draft` hanya id, `min(1).max(80)`, `.catch(undefined)`.
- P3 (UX, tidak menahan): setelah sukses lalu tekan Back, `?draft=` muncul lagi dan "Kirim pesanan" memberi 412 dengan teks "Pesanan belum terkirim". Tidak ada risiko uang atau pesanan dobel.
- P3: `actorId` memakai `useActorId` (bukan `useCaptainActorId`), benar untuk kasir. Mode mock langsung return.

## `listAgeMs`
- `max(0, now - dataUpdatedAt)`, -1 bila belum pernah dibaca. Mencegah umur negatif lolos ke `oldLinkRemainingIdr` (`listAgeMs >= 0 && < 20s`). Perilaku lama sudah sama untuk kasus normal. Test mencakup refetch setelah `now`.

## `e2e/pos-real.spec.ts`
- Seeding SQL tidak bocor: semua baris memakai id acak dan slug acak (tenant sendiri, host `<slug>.legend.test`), tenant-scoped (RLS lewat `set_config`). Koneksi dari `STARTER_TEST_DATABASE_URL`, dan `playwright.config.ts` menolak jalan tanpa DB sekali pakai dari `pnpm test:e2e`. Tidak ada data global yang diubah.
- Angka laci benar: modal 100.000 + tunai 55.000 (diserahkan 100.000, kembalian 45.000) = 155.000. Tagihan EDC tidak masuk. Hitung buta (`expectedIdr` null di sisi kasir), supervisor melihat selisih 0.
- P3: tes "satu override untuk satu tagihan" ditolak karena sisa tagihan sudah 0, bukan pasti karena override dipakai ulang. Untuk membuktikan override sekali pakai, ulangi dengan tagihan kedua. Komentar `afterAll` tentang "valid creator" tidak ada isinya (`created_by` acak), tidak merusak apa pun.
- Celah cakupan: spec hanya API, tidak menyentuh layar `?draft=` (hanya test unit).
