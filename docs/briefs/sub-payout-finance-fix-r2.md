# Sub-brief ronde 2: perbaikan audit UI (14 Nov 2026)

Baca dulu `docs/briefs/sub-payout-finance-ui.md` (aturan keras, pembagian file tetap sama). Ikuti `~/.agents/team/ui-standard.md`.
Path relatif ke `apps/web/src/features/`. P = `ws10-payroll-payout/components`, X = `ws07-finance-exceptions/components`.
Mockup PNG: lihat sub-brief pertama (baca hanya layar yang kamu ubah).

Aturan: hanya file milikmu. Teks baru masuk katalog milikmu. Jangan sentuh `components/ui/*` bersama, `money.tsx`, shell aplikasi, API. Jangan jalankan tsc/vitest/playwright. Selesai: `pnpm exec prettier --write` + `pnpm exec eslint` pada file sendiri (path berisi spasi: pakai kutip). Jangan ubah selector yang dipakai `e2e/payout.mock.spec.ts` / `e2e/finance-exceptions.mock.spec.ts` tanpa menyebutnya di laporan (role + nama aksesibel, heading, teks tombol). Laporan: daftar perubahan per file + teks/label yang berubah.

## A. `P/payout-page.tsx`, `P/runs-tab.tsx`, `ws10-payroll-payout/lib.ts`, katalog `payrollPayout`
1. Overflow 390 (KRITIS): halaman 475px. Outer grid `grid-cols-[minmax(0,1fr)]`, `<Tabs className="min-w-0">`, pastikan TabsList bisa scroll horizontal di dalam kolom. Cek juga anak grid lain tanpa `min-w-0`.
2. Urutan bingkai seperti mockup: judul, tab, lalu pilih PT, lalu isi tab.
3. "Badan usaha (opsional)": field selalu terisi, pakai `required` atau buang sufiks.
4. Runs tab: satu aksi utama. Baris hanya memilih (tombol pilih jelas, state terpilih terlihat: tint/border, bukan side-stripe; `aria-current="true"`). Panel samping: aksi utama penuh lebar, tinggi ≥44px ("Tinjau persetujuan"/"Siapkan"/dll sesuai state). Mobile: setelah memilih, scroll/fokus ke panel. Tombol "Buka pengaturan" jangan diulang per baris (cukup satu banner/aksi).
5. Kata Inggris "run" di teks UI → "periode gaji" (atau padanan konsisten). Jumlah tetap benar.
6. Mask rekening di `lib.ts` (bila ada): bullet kecil `••••` bukan `●●●●`.

## B. `X/*`, `ws07-finance-exceptions/lib.ts`, katalog `financeExceptions`
1. Fokus kartu ringkasan 1.29:1: `focus-visible:border-primary` + ring 2px kontras ≥3:1.
2. Ringkasan: satu strip tergabung (satu border, pemisah), baris label/jumlah/nominal sejajar (label block tinggi tetap atau grid-rows).
3. `aria-live="polite"` pada jumlah hasil.
4. Short-id referensi: tampilkan ekor yang membedakan, mis. `…` + 6 karakter terakhir; id lengkap tetap di `details`.
5. Render ganda daftar (kartu + tabel, s.d. 500 baris): render satu layout via hook media query (aman SSR: default desktop, ganti setelah mount) atau `content-visibility:auto`. Pilih yang tidak merusak spec mock.
6. Card-in-card: hilangkan border luar ganda (bungkus sendiri, jangan ubah `DataTableShell` bersama).
7. Header tabel band abu, baris lebih lega (~py-4).
8. Filter: buang "(opsional)" pada Jenis/Outlet, garis tipis antara filter dan baris "Tanggal bisnis · Maks 92 hari / Atur ulang". Callout `border-l-2` → blok tint + ikon Info.
9. `selectKind` jangan buang edit filter lain yang belum diterapkan (bila mudah).

## C. `P/settings-*.tsx`, katalog `payrollPayoutSettings`
1. "Batas per transfer" dan "Batas harian" sejajar (penanda opsional ke hint atau `items-end`).
2. Input rupiah `min-h-11` sama dengan Select.
3. Duitku: tetap nonaktif; catatan singkat bahwa kredensial Duitku diisi saat akun siap (API baru punya `integrationId`).

## D. `P/approval-*.tsx`, `P/status-*.tsx`, katalog `payrollPayoutReview`
1. Pill status batch di `status-tab.tsx` selalu amber: pakai `Badge tone={batchStatusMeta(status).kind}` seperti runs-tab.
2. Step-up dan dialog jadi `<form onSubmit>`: Enter mengirim, fokus ke field pertama saat panel muncul, tombol Batal tetap ada saat step-up, field referensi bank `spellCheck={false} autoComplete="off"`. Tombol tetap dinonaktifkan selama pending (cegah kirim ganda).
3. Id DOM ganda `status-block-${id}` di tabel+kartu: beri sufiks layout.
4. Pilihan "Gagal"/"Tidak terkirim": nonaktif dengan alasan inline (unggah bukti belum tersedia), tidak bisa dipilih.
5. Tombol tindak lanjut status: lebar konten, outline, bukan penuh kolom. Tile ringkasan: label sentence-case tenang (tanpa uppercase tracking), angka besar, nominal di bawah, tanpa wrap aneh; grid tanpa baris yatim.
6. Approval steps: "Sudah diajukan" bar hijau penuh lebar, "Menunggu verifikasi" bar amber penuh lebar (lihat mockup approval).
7. Tabel penerima: header band abu uppercase kecil, baris ~70px, nama tebal + peran muted. "Rekening sumber" di panel rincian tidak wrap 3 baris (truncate/nowrap + title).
