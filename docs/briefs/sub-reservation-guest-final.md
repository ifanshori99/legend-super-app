# Perbaikan akhir (audit + finish review) legend-g12il

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-reservation-guest`. `F = apps/web/src/features/ws08-reservation-guest/components/`. Konteks: `docs/briefs/sub-reservation-guest.md`. Tanpa tsc/heavy. Setelah selesai: `pnpm exec prettier --write <file>`, `pnpm exec eslint <file>`, `node --test tests/text-contract.test.mjs`. Teks UI baru hanya lewat katalog milik potonganmu (tanpa literal JSX). Jangan sentuh file potongan lain. UI tidak menghitung nominal DP.

## A — `F/guest-manage-page.tsx`, `F/screens/recovery-screens.tsx`, `F/screens/detail-screen.tsx`, katalog `packages/shared/src/i18n/messages/reservation-guest-request.ts`
1. Layar error, rate-limit, dan link tidak berlaku tidak pernah diumumkan atau difokus (`guest-manage-page.tsx:96-108`: `contentShown` mensyaratkan `view`). Masukkan layar-layar ini ke kunci fokus. Fokuskan h1-nya saat menggantikan loading, termasuk setelah "Coba lagi" lalu error lagi. Tambah `role="alert"` di paragraf lead ketiga layar itu sebagai cadangan.
2. Detail yang dibuka dari permintaan pending (`guest-manage-page.tsx:174-179`, `detail-screen.tsx:53-57,:91`):
   - Saat `requestPending`, lead jangan mengajak "ajukan perubahan". Pakai teks seperti versi late, tapi untuk pending.
   - Tambah `GuestNote` "Permintaan jadwal baru sedang diperiksa outlet." (key baru).
   - Tambah aksi tenang (variant link) "Kembali ke status permintaan" yang memanggil `setStep("main")`.

## B — `F/screens/reschedule-screen.tsx`, `F/screens/cancelled-screen.tsx`, katalog `packages/shared/src/i18n/messages/reservation-guest-cancel.ts`
1. `reschedule-screen.tsx:309`: lingkaran radio pakai `border-input`, bukan `border-border`, agar kontras 3:1. Border chip boleh tetap lembut.
2. Hapus `aria-busy` di `reschedule-screen.tsx:150` dan `:333`, karena membungkus `role="status"`.
3. Hapus fokus h1 saat mount di `reschedule-screen.tsx:105-107`; efek halaman sudah menanganinya. Fokus saat `isPending` atau `attempt` tetap.
4. `cancelled-screen.tsx:138-139`: error cek status pengembalian pakai key baru "Status pengembalian belum bisa diperiksa. Coba lagi sebentar lagi." dengan `role="alert"`, bukan `role="status"`.

## C — `F/typography.ts`, `F/guest-shell.tsx`, `F/reservation-summary.tsx`, `F/deposit-breakdown.tsx`, `F/guest-actions.tsx`
1. Mobile mengikuti blok mockup `@media (max-width: 760px)`:
   - `guestTitle`: tambah `max-[760px]:text-[28px]`.
   - Gutter shell: `max-[760px]:px-5`.
   - Padding panel summary dan deposit: `max-[760px]:p-5`.
   - Baris tanggal summary: `max-[760px]:text-[17px]`, jarak visit-time 16px di mobile.
2. Desktop, `guest-shell.tsx:25`: konten 680px. Pakai `max-w-[46rem]` (sudah termasuk px-6) dan `min-[900px]:pt-12`.
3. Placeholder brand saat brand null di `guest-shell.tsx`: pakai skeleton terang lokal `[--skeleton:#e9dfd4]`, bukan `--skeleton` gelap global.
4. `guest-actions.tsx` (paritas mockup `cancel-late-1280`):
   - Mulai `sm`, aksi sekunder outline tidak full width (rata kiri, lebar sesuai isi). Tombol primer tetap.
   - Tombol: font-weight 750 dan radius 12px.
   - Link batal: bold, garis bawah tetap ada (alasan aksesibilitas).
   - Jangan merusak tombol `h-auto whitespace-normal` di cancel-screen pada lebar 320.

## D — `scripts/ui-check-reservation-guest.mjs`
1. Keadaan `submitting`: pilih 2026-11-19 dan 19.30, sama seperti `reschedule`, agar kartu yang diajukan berisi "Kamis, 19 November 2026 / 19.30 WIB".
2. Di akhir keadaan `reschedule` (dan `validation` bila ada isian): jalankan `document.activeElement.blur()` dan gerakkan mouse ke (0,0) sebelum screenshot.
