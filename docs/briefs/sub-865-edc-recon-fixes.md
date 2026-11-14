# Sub-brief 865 perbaikan putaran 1

Konteks: `docs/briefs/sub-865-edc-recon-ui.md`. Fitur `apps/web/src/features/edc-reconciliation/`. Jangan jalankan tsc/test; jalankan `pnpm exec eslint <file kamu>` dan `pnpm exec prettier --write <file kamu>` (ringan). Jangan commit.

## F1 (daftar): queue-page.tsx, queue-list.tsx, route `apps/web/src/routes/_kelola/kelola.pembayaran_.edc-rekonsiliasi.tsx`, katalog `edc-recon-queue.ts`

1. ESLint: `queue-page.tsx:90,103` react-hooks/set-state-in-effect; `:147-148` react-hooks/refs (simpan item terakhir tanpa membaca ref saat render: state yang di-set di handler/derived, atau `useState` + perbandingan saat render pola React docs "storing info from previous renders").
2. Deep link mobile `?tx=` saat loading/error: slot detail kosong. Tampilkan skeleton / ErrorState + Coba lagi di slot detail.
3. `draft` pencarian tidak disinkron dari `search.q` (back/forward mendorong draft basi). Sinkronkan tanpa set-state-in-effect.
4. Route `validateSearch`: `status` pakai enum tiga nilai yang sama dengan filter halaman (bukan string bebas), loader memakai filter yang sama dengan halaman.
5. Refetch gagal saat data ada: jangan ganti daftar dengan error penuh; tampilkan banner + data lama.
6. 320 px: sel status di kartu mobile `flex-wrap` / baris sendiri; pill tidak boleh meluap.
7. Setelah resolve (`onResolved`): fokus ke judul daftar (tabIndex -1) supaya fokus tidak jatuh ke body.
8. Input cari: `autoComplete="off"`, `spellCheck={false}`, placeholder diakhiri "…". Tombol Muat ulang jangan `disabled` saat fetch (pakai aria-busy/loading) supaya fokus keyboard tidak hilang.

## F2 (detail + penyelesaian): detail.tsx, resolve-form.tsx, confirm-dialog.tsx, katalog `edc-recon-resolve.ts`, dan `apps/web/src/features/ws10-payroll-payout/components/approval-verify.tsx` (hanya tambah prop opsional, perilaku lama tetap)

1. TS2322 `confirm-dialog.tsx:65`: `chargedAmountIdr` harus bertipe brand Idr — parse lewat skema shared (`idrSchema.parse` atau `resolveEdcReconciliationBodySchema.parse(body)`) bukan cast.
2. ESLint `confirm-dialog.tsx:117` react-hooks/set-state-in-effect.
3. `<VerifyPanel key={stepUp.round} …>` (pola ws10) supaya MFA ulang meminta kode baru.
4. Copy MFA: `VerifyPanel` memakai teks payout ("Pencairan uang…"). Tambah prop opsional (mis. `hintKey`/`copy`) di approval-verify.tsx; EDC memakai teks sendiri di `edcRecon.resolve.verify.*`.
5. `EDC_AMOUNT_MISMATCH` tidak pernah dikirim API (jadi `CONFLICT` + pesan "Nominal di terminal EDC tidak sama dengan tagihan."). Cocokkan code CONFLICT + pesan itu; copy netral tanpa angka ("Nominal tidak sama dengan permintaan atau tagihan sudah berubah. Periksa ulang bukti dan status tagihan."). Pesan validasi nominal di form juga tanpa menuliskan angka yang diharapkan.
6. Pada CONFLICT / NETWORK_ERROR: invalidasi queue + tombol "Muat ulang daftar" di dialog.
7. Struk: baris nominal menampilkan `tx.amountIdr` seolah tercetak → label "Nominal permintaan"; baris "Hasil pada struk" → "Status sistem" via kunci `status.*` (bukan `toUpperCase()` / raw status, `detail.tsx:254,272`). Trace kosong → fallback "–" juga di dialog (`confirm-dialog.tsx:219`).
8. `useNowMs` di detail mulai `null` sampai mount (hindari hydration mismatch), sama seperti queue-page.
9. Key form `detail.tsx:297` hanya `tx.id`. Bila status/gate berubah saat form terbuka: tampilkan notice "Status transaksi berubah", hitung ulang outcome yang diizinkan, jangan hapus isian; dialog/sukses tidak boleh ter-unmount.
10. Checkbox konfirmasi: satu `<label className="flex min-h-11 items-start gap-3 py-2">` membungkus kotak + teks (target ≥44 px).
11. Kirim dengan error: fokus ke field pertama yang tidak valid.
12. Judul detail `h3` (halaman sudah punya h2 daftar). Penghitung catatan diikat ke textarea lewat `aria-describedby`.
