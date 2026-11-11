# sub-539-u1 fix 1 (temuan reviewer, commit 0f32a52a)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-cashier-captain`. Semua path di bawah relatif ke `apps/web/src/features/ws04-pos-order/` kecuali disebut. Jangan commit. Jangan jalankan tsc/build/Playwright (agent). Hanya berkas kelompokmu. Laporan ≤10 baris.

## Antarmuka hook baru (FD menulis, FK/FC memakai)

- `useSubmitOrder({ draftKey: string })`, `useAddToTable({ draftKey: string })`: di `onSuccess` level `useMutation` (bukan per-`mutate`), kosongkan draft store `draftKey`. Komponen hanya navigasi di per-mutate onSuccess. Kunci idempotensi disimpan per `draftKey` di modul (bukan useRef), sidik jari memuat outletId; dibuang setelah sukses.
- `useResumeDraft({ draftKey: string })`: `onSuccess` level hook menambahkan baris draft yang dilanjutkan ke draft store `draftKey`.
- `lineTotalIdr(line: CartLine | OrderLine): number` diekspor dari `cart-logic.ts` (dengan Math.round). Captain memakainya, hapus duplikat.

## FD (data): cart-logic.ts, draft-store.ts, mock-engine.ts, hooks.ts, api.ts, index.ts, tests/ws04-pos-order-*.test.mjs

1. `addLine`: jangan gabung ke baris yang `hold: true` (kunci gabung memuat hold=false).
2. `validateModifiers` + engine `normalizeLines`: tolak optionId ganda dalam satu grup.
3. `setQuantity`: NaN / non-integer → abaikan (baris tetap), bukan hapus.
4. `draft-store`: validasi snapshot sessionStorage (bentuk CartLine); buang bila rusak.
5. Engine `parkDraft`: boleh menyimpan item stok habis (hanya cek bentuk); `addToTable`: validasi sebelum membuat pesanan baru (tanpa pesanan hantu).
6. Hook sesuai "Antarmuka hook baru". 7. Lint: hapus parameter `_outletId` tak terpakai di api.ts (5 tempat) tanpa mengubah perilaku.
7. Tambah test untuk 1, 2, 3, 5 di tests/ws04-pos-order-*.test.mjs.

## FK (kasir): components/cashier/*, components/modifier-dialog.tsx, apps/web/src/routes/_ops/pos.kasir.tsx, packages/shared/src/i18n/messages/pos-order-{catalog,cart}.ts

1. Pakai `useSubmitOrder({ draftKey: "kasir" })` / `useResumeDraft({ draftKey: "kasir" })`; hapus `cart.clear()` per-mutate.
2. Error data hanya bila `!data` (data cache tetap tampil + Notice kecil bila refetch gagal): catalog-pane:85, parked-drafts-sheet:83, channel-toggle:275.
3. Saat submit pending: stepper/hold/hapus baris dikunci (`aria-disabled`).
4. Error submit menampilkan pesan server (ApiError.message) + baris penyebab bila ada (ITEM_SOLD_OUT/INVALID_MODIFIER).
5. Pindai/Enter kode tak dikenal atau stok habis: pesan `role="status"` di bawah kolom cari ("Kode … tidak ditemukan" / "… stok habis").
6. Setelah submit: navigasi ke `/pos/bayar/$orderId` hanya bila akses memegang `pos.payment.accept`; selain itu toast/notice sukses dengan nomor pesanan.
7. "Kirim item ditahan" (sebelum ada pesanan): tetap melepas status tahan, tapi beri umpan balik jelas `role="status"`: "N item ditahan akan dikirim bersama pesanan ini".
8. ModifierDialog: error grup wajib merah + aria-describedby baru muncul setelah percobaan "Tambah ke keranjang"; sebelum itu label "Wajib pilih satu" netral.
9. cart-pane: jangan `role="status"` per baris; satu live region untuk total.

## FC (captain): components/captain/_, routes \_ops/pos.captain._, packages/shared/src/i18n/messages/pos-captain-{tables,order}.ts

1. review-screen: `useAddToTable({ draftKey: \`captain:${tableId}\` })`; hapus clear per-mutate; error menampilkan pesan server.
2. Error data hanya bila `!data`: add-order-screen:129, table-order-screen:70, tables-screen:132.
3. table-order-screen:90: "Kirim {course} ke dapur" menembak SEMUA baris held di course itu.
4. add-order-screen: tampilkan error bila `tableOrder` gagal (meja tak ditemukan → kembali ke daftar meja); item dengan satu baris draft tetap punya "+ Tambah" untuk varian/modifier lain bila item punya grup modifier.
5. captain-order-parts: pakai `lineTotalIdr` dari cart-logic.
