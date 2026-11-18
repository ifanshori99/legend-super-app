# 1046 sub-brief: POS jual tiket fasilitas (web)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-fc88d48f` (branch ghostex/fc88d48f, base 9a530a3a9 = backend 1039 + UI 936).
Induk: `/Users/ifanshori99/Projects/legend super app/legend/docs/briefs/1046-pos-jual-tiket-web.md`.

## Tujuan
Kasir menambah tiket fasilitas ke tagihan POS, bayar, lalu kredensial QR+PIN tampil SEKALI
(tidak bisa dibuka ulang), cetak lewat jalur print yang ada (ganti `printTicket` mock).
UI sudah disetujui founder (Q19): ikuti screenshot, JANGAN desain ulang:
- `/Users/ifanshori99/Projects/legend super app/legend/docs/review/ui-review-936-payout.html`
- `/Users/ifanshori99/Projects/legend super app/legend/docs/review/img/pos936-tiket-terbit-light-{360,1280}.png`
Tanpa migrasi. Tingkat K (uang): jangan ubah perhitungan harga di klien; server yang menentukan.

## Peta kode
- Web: `apps/web/src/features/ws04-pos-kasir/` (`ticket/{api,types,hooks,mock,queries,connected}.ts`,
  `components/ticket/`, `CONTRACT-GAPS.md`, `api.ts`, `types.ts`, `mock-engine.ts`).
- API (backend 1039): `apps/api/src/routes/facility-pos-ticket.routes.ts`,
  `apps/api/src/services/facility-pos-ticket{s,-sale,-print,-hold}.ts`, test `apps/api/src/test/pos-936-ticket.test.ts`.
- Shared: `packages/shared/src/validators/` (cari `posDiscountSchema`, `posEdcAttemptSchema`).

## Potongan
A. Shared: `posDiscountSchema` terima kode voucher; `posEdcAttemptSchema` terima bank/mode. Bentuk
   HARUS sama dengan yang backend baca (cek route/service API). Strict zod.
B. Web data: `ticket/api.ts` + hooks memanggil endpoint nyata (jual tiket ke tagihan, terbitkan kredensial,
   cetak). Kredensial (QR+PIN) hanya di state memori sesudah respons terbit; tidak di query cache yang
   bisa di-refetch, tidak di localStorage. Cetak lewat jalur print yang ada (cari helper print struk POS).
C. Web UI: layar tiket mengikuti screenshot; kondisi loading/kosong/error/sukses. Teks baru masuk katalog
   text-contract proyek (cari skrip `text-contract`/katalog teks di repo).
D. Test: unit (vitest web) untuk api/hooks dan "kredensial sekali tampil"; Playwright mock terarah
   (spec baru di `e2e/`, pola spec POS 936 yang ada) + screenshot 360 dan 1280 light.

## Aturan
- Jalankan perintah berat hanya lewat `heavy` (hanya satu subagent pemegang token heavy: test-runner).
- Jangan commit; agent induk yang commit.

## Keputusan agent (sesudah Explore) — WAJIB diikuti

Kontrak server (apps/api/src/routes/facility-pos-ticket.routes.ts):
- `POST /facility/tickets/pos` (`sellAccessTicketAtPos`): tiket `pending_payment` + tagihan POS. `ticket/api.ts:sellTicketAtPos` sudah ada.
- `GET /pos/orders/:orderId/tickets`: `{tickets:[{ticket, orderItemId, lineStatus: pending|issued|cancelled|refunded, lineTotalIdr}]}`.
- `POST /pos/orders/:orderId/tickets/:ticketId/credential` body `{idempotencyKey}` (`issueTicketCredential` sudah ada). Tiap panggilan dengan kunci BARU memutar kredensial (QR/PIN lama tidak berlaku) dan mencetak via Print Agent (`print.printedAt` null = tidak ada printer/cloud). Kunci sama dipakai ulang → 409 `TICKET_CREDENTIAL_SHOWN`. Error lain: 409 `TICKET_NOT_PAID`, `TICKET_HOLD_LAPSED`, `TICKET_NEEDS_CLOUD`, `TICKET_TRANSITION_INVALID`, 422 `TICKET_PRODUCT_NOT_SELLABLE_AT_POS`.

Alur UI:
1. `/pos/tiket` (tanpa search): form jual → tombol jual → `sellTicketAtPos` → `navigate` ke `/pos/bayar/$orderId`.
2. Layar bayar (`/pos/bayar/$orderId`), saat tagihan LUNAS: bila `useOrderTickets(orderId)` punya baris `issued`, tampilkan kartu kecil "tiket siap diterbitkan" dengan Link ke `/pos/tiket?order=<orderId>&tiket=<ticketId>` (data dari server, bukan search param).
3. `/pos/tiket?order&tiket`: kartu ringkasan tiket (dari `useOrderTickets`) + tombol eksplisit "Terbitkan tiket" (tidak otomatis saat mount). `pending` → pesan belum lunas + link bayar; `cancelled|refunded` → error. Sukses → `IssuedTicket` (tampilan persis screenshot), kredensial HANYA di `useState` komponen.
4. `IssuedTicket` tombol "Cetak tiket" = panggil issue lagi dengan kunci baru → ganti QR/PIN di layar + catatan bahwa kode lama tidak berlaku. Tampilkan status cetak: tercetak di <printer> / printer tidak tersedia, tunjukkan QR.
5. Reload `/pos/tiket?order&tiket` tidak menampilkan kredensial lama: kembali ke langkah 3 (klik lagi = putar kredensial).

Antarmuka hooks (`ticket/hooks.ts`, dibuat implementer B, dipakai implementer C):
- `useSellTicketAtPos()`: `useMutation<TicketBillSale, ApiError, SellTicketInput>` (kunci niat `useIntentKey`).
- `useOrderTickets(orderId: string)`: `useQuery` → `OrderTicketLine[]` = `{ ticketId, orderId, lineStatus, productName, customerName, facilityName, areaName, unitCode: string|null, startsAt, endsAt, priceIdr }` (isi yang tidak ada di DTO: string kosong/null; jangan hitung harga, pakai `lineTotalIdr`).
- `useIssueTicketCredential()`: `useMutation<TicketCredential, ApiError, { orderId: string; ticketId: string }>`; kunci BARU per `mutate` (`crypto.randomUUID()`); hasil tidak disimpan di query cache/storage. Invalidate `useOrderTickets` sesudahnya bila perlu.
- Hapus `sellTicket`, `printTicket`, `usePrintTicket`, `useSellTicket`, `SoldTicket`, `PrintTicketResult` dan mock lamanya bila tak terpakai. `TICKET_SALE_CONNECTED` = true (layar tidak terkunci di luar mock).
- Mode mock (`API_MOCK`): fungsi api yang sama memanggil mock-engine yang meniru server: jual membuat pesanan mock yang bisa dibayar di `/pos/bayar/$orderId?demo=...`; tiket jadi `issued` saat pesanan mock lunas; issue memutar kredensial.

Potongan A (diputuskan): tambah field respons nullable, isi dari kolom DB yang sudah ada, tanpa migrasi:
- `posDiscountSchema.voucherCode: string|null` (dari `pos_order_discounts.promo_code`, hanya bila source voucher/promo), mapping di `apps/api/src/services/pos-order-support.ts` (~1457).
- `posEdcAttemptSchema.bank: string|null`, `mode: string|null` (enum bila kolom DB enum) dari `edc_transactions`, mapping `edcAttemptsOf` (~1263).
- Web `ws04-pos-kasir/api.ts` memetakan field itu (baris voucher tampil dengan kode; bank/mode EDC ditolak tidak lagi kosong). Update baris 63 dan 71 `CONTRACT-GAPS.md`. Tambah assert di `apps/api/src/test/pos-936-voucher.test.ts` dan `pos-936-edc-declined.test.ts`.

Kepemilikan file (jangan menyentuh milik potongan lain):
- A: `packages/shared/src/pos/schemas.ts`, `apps/api/src/services/pos-order-support.ts`, `apps/web/src/features/ws04-pos-kasir/api.ts`, `types.ts` (field baru saja), `CONTRACT-GAPS.md`, dua test API di atas.
- B: `ticket/*.ts`, `mock-engine.ts`/`mock.ts`/`fixtures.ts`/`demo-seed.ts` bagian tiket.
- C: `components/ticket/*`, `apps/web/src/routes/_ops/pos.tiket.tsx`, komponen layar bayar sukses (kartu tiket), `packages/shared/src/text/dictionary.ts` (SEMUA teks baru lewat katalog).
- D: `apps/web/test/*ticket*`, `e2e/legend-1046-pos-tiket.mock.spec.ts`.

## Potongan E (tambahan): nama tampilan di daftar tiket pesanan
Masalah: `GET /pos/orders/:orderId/tickets` (`listPosOrderTickets`, packages/shared/src/pos/ticket.ts) hanya membawa id,
jadi di mode nyata layar tiket terbit tanpa nama produk/fasilitas/area/bilik/pelanggan (lihat `fetchOrderTickets` di ticket/api.ts).
Kerjakan: tambah ke tiap baris respons `display: { productName, facilityName, areaName, unitCode: string|null, customerName }`
(strict zod), diisi server dengan join baca saja (pakai ulang lookup detail di `facility-pos-ticket-print.ts`/`facility-pos-tickets.ts`
~baris 590 bila ada). Tanpa migrasi, tanpa mengubah harga/status. Web: `fetchOrderTickets` memetakan `display` (hapus string kosong).
Assert di `apps/api/src/test/pos-936-ticket.test.ts`. File milik E: `packages/shared/src/pos/ticket.ts`, route/service facility-pos-ticket*,
`ticket/api.ts` (fungsi fetchOrderTickets saja), test API itu.
