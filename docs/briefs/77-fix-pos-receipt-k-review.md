# Brief: engineer — perbaikan review K ws/pos-receipt (d379023)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/pos-receipt`, cabang `ws/pos-receipt`. Jangan baca `.env*`, jangan `pkill`. Langkah pertama: pecah dan spawn subagent paralel.

## Temuan (reviewer Opus + architect, dua-duanya PERLU FIX)
1. Tinggi — nomor struk ganda edge vs cloud. `routes/pos-order.routes.ts:88` selalu kirim `deviceId: null` → urutan milik outlet (`deviceKey = outletId`, `pos-receipt.service.ts:313`), edge dan cloud masing-masing pilih prefix `P1` lewat `nextFreePrefix` (`:174-179`, `:134`). Merge menolak `deviceId === outletId` (`:493`) dan prefix bentrok → `RECEIPT_PREFIX_MISMATCH` permanen.
   Fix: isi `deviceId` dari sesi perangkat terdaftar; di `EDGE_MODE` tolak penjualan tanpa perangkat/prefix (fail closed); prefix perangkat hanya dari cloud (`provisionReceiptSequence`), `ensureSequence` di edge tidak memilih prefix sendiri; urutan milik cloud pakai ruang nama prefix sendiri.
2. Sedang — void dari merge (`:610-617`, `:698-715`): `voidedBy`/`voidReason` mentah dari perangkat, tanpa `voidReasonSchema`, tanpa cek pengguna, pesanan tetap `completed`, tanpa jurnal balik. Fix: tolak void offline tanpa event void pesanan yang cocok (lewat jalur void + approval), validasi isian.
3. Rendah — merge terima `orderId` pesanan mana pun di outlet (`:546-561`, `:310`). Fix: hanya pesanan `completed`/`voided` dari perangkat yang sama.
4. Rendah — cetak ulang tanpa tanda "CETAK ULANG" (`pos-receipt-pdf.ts:156`, `pos-receipt-document.ts`): tampilkan bila `reprintCount > 0`.
5. Di luar cabang ini: `mergeDeviceReceiptRun`/`receiptGapsForOutlet` belum dipanggil dari sinkron edge atau tutup hari (`edge/ports.ts:56` apply masih stub). Buat bead lanjutan (`bd create`, tandai prasyarat gerbang rilis), jangan kerjakan di sini kecuali kecil.
6. Migration bentrok dengan main (0063–0067): merge `main` ke cabang, renumber via drizzle-kit, jangan edit `_journal.json` tangan.

## Bukti selesai
Test regresi per temuan, termasuk: penjualan edge + cloud di outlet sama tidak menghasilkan nomor ganda dan merge diterima. Gerbang penuh `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`. Reviewer subagent konteks segar. Commit lokal. Laporan: SHA, test, migration lama→baru, id bead lanjutan.
