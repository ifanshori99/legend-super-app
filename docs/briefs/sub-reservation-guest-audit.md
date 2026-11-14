# Perbaikan audit ui-auditor (legend-g12il)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-reservation-guest`. Folder `F = apps/web/src/features/ws08-reservation-guest/components/`. Konteks umum `docs/briefs/sub-reservation-guest.md`. Tanpa tsc/heavy; prettier --write + eslint + `node --test tests/text-contract.test.mjs` setelah selesai. Teks baru hanya lewat katalog milik potonganmu.

## I1 — `F/screens/reschedule-screen.tsx` saja (tanpa teks baru)
1. Saat `isPending` form diganti tampilan submitting → fokuskan h1 saat `isPending` berubah (masuk dan keluar). Saat error kembali, fokus ke pesan/heading.
2. Kotak jam: radio `sr-only` → tambah `peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring` pada span; terpilih vs fokus harus beda.
3. Jangan `setProblem(null)` tiap onChange (Summary/heading melompat). Hapus problem hanya saat submit ulang. Efek fokus pakai counter `attempt` supaya submit kedua dengan masalah sama tetap memfokus.
4. Fieldset jam saat error: `aria-invalid` + `aria-describedby` ke id pesan error.
5. Input date/time `autoComplete="off"`.

## I2 — `F/screens/cancel-screen.tsx`, `cancelled-screen.tsx`, `recovery-screens.tsx`, `late-screen.tsx`, `F/deposit-breakdown.tsx`, katalog `packages/shared/src/i18n/messages/reservation-guest-cancel.ts`
1. Cancel submit: fokus ke h1 atau region status saat submit dan saat error; tambah `<p role="status">` teks submitting.
2. `recovery-screens.tsx`: hapus `aria-busy` dari kontainer yang membungkus `role="status"`; boleh hanya di area skeleton.
3. `cancelled-screen.tsx` "Periksa status pengembalian": setelah refetch tampilkan `<p role="status">` hasil ("Status diperbarui pukul {jam}" / "Belum ada perubahan"); teks tombol tetap saat loading.
4. `DepositBreakdown`: `aria-labelledby` ke heading, bukan `aria-label` sama; prop `headingLevel` (h2 default, h3 di late-screen yang sudah punya h2 induk).

## I3 — `F/guest-manage-page.tsx`, `F/screens/detail-screen.tsx`, `F/screens/screen-helpers.ts`, `F/guest-shell.tsx`, `apps/web/src/features/ws08-reservation-guest/hooks.ts`, katalog `reservation-guest-request.ts`
1. DetailScreen prop `late: boolean` (dari `isLateForReschedule`). Saat late: sembunyikan "Ajukan jadwal baru", teks kebijakan versi "batas sudah lewat" (tanpa hitung nominal), "Batalkan reservasi" satu-satunya aksi (tetap tidak primer merah? ikuti mockup late: aksi tenang). Dari LateScreen `onKeep` → DetailScreen late, tidak ada loop.
2. Zona waktu: `useGuestTimeZone` kembalikan `{timeZone, ready}`; halaman tahan di loading sampai data situs selesai (sukses/gagal). Bila outlet cocok pakai zonanya; selain itu fallback `Asia/Jakarta` dengan komentar `// legend-z5ygw: view belum membawa timeZone`.
3. Fokus heading dobel: hanya satu mekanisme (efek halaman), jangan fokus saat loading awal pertama kali.
4. `aria-busy` di pembungkus halaman (`guest-manage-page.tsx` sekitar :186) jangan membungkus region `role="status"`.
5. `GuestShell` header: `min-h` tetap supaya tidak bergeser saat brand datang.
