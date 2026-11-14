# Polish sesuai mockup (legend-g12il)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-reservation-guest`. `F = apps/web/src/features/ws08-reservation-guest/components/`. Konteks `docs/briefs/sub-reservation-guest.md`. Mockup: `git show origin/design/reservation-guest:design/mockups/reservation-guest/<file>` (styles.css = angka acuan; PNG `<state>-mobile.png`/`-desktop.png` bisa diekstrak ke scratchpad). Perbandingan berdampingan: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend/cf794d90-9259-4d55-8a86-1ce7ee572873/scratchpad/cmp/<state>-<390|1280>.png` (kiri mockup, kanan build). Tanpa tsc/heavy; prettier --write + eslint + `node --test tests/text-contract.test.mjs`. Warna lewat token yang ada (`styles/tokens.css`, cari success/warning tint di `[data-surface="qr"]` dan global); bila tidak ada padanan, variabel CSS lokal di kelas Tailwind arbitrary `[--x:...]` pada `GuestShell`, bukan hex tersebar.

DIPERTAHANKAN (jangan ubah): format uang `Money` app ("Rp 50.000"), nama outlet satu baris (`outletName` satu field), slot jam dari availability nyata (boleh banyak), ikon+teks error validasi.

## P1 — komponen bersama: `F/guest-shell.tsx`, `F/status-pill.tsx`, `F/guest-note.tsx`, `F/guest-actions.tsx`, `F/reservation-summary.tsx`, `F/deposit-breakdown.tsx`, file baru `F/typography.ts`
- `typography.ts` ekspor string kelas: `guestTitle` (h1: 30px/1.22, tracking -0.035em, weight 750, text-balance), `guestHeading` (h2: 20px/700), `guestBody` (16px), `guestHint` (16px muted). Pakai di komponen milikmu.
- Shell: gutter 24px mobile, padding atas 32px, jarak header→konten 32px, blok antar-bagian 24px; brand selalu tampil (saat brand null: titik rust + bar skeleton lebar tetap, bukan kosong).
- Pill: border 1px, 14px/700, padding 5px 12px; netral = latar card + border hangat; success/warning = tint + border sesuai styles.css mockup.
- Note: border kiri 3px, sudut kanan 12px kiri 0; tone info latar card rule `#8b7765`-padanan; warning latar amber tint; success latar hijau tint.
- Actions: tombol bobot 750 radius 12px; ≥ sm grid 2 kolom, anak pertama `col-span-2`; tautan aksi tanpa garis bawah, bold rust (garis bawah saat hover/focus).
- Summary/Deposit: padding panel 24px, ikon outlet 40px, judul rincian = `guestHeading`.

## P2 — `F/screens/detail-screen.tsx`, `reschedule-screen.tsx`, `request-status-screen.tsx`, katalog `reservation-guest-request.ts`, `apps/web/src/features/ws08-reservation-guest/mock.ts`
- Semua h1 `guestTitle`, h2 `guestHeading`, paragraf bantu 16px (`guestBody`/`guestHint`) dari `F/typography.ts` (dibuat P1 paralel).
- Detail: batas DP tebal, copy "paling lambat {deadline}." dengan format "Selasa, 17 November 2026, 19.00 WIB" (koma, bukan "pukul") — ikuti copy mockup `states-booking.js`.
- Validation (problem `past`): judul "Periksa tanggal baru", lead "Tanggal yang dipilih sudah lewat. Ganti tanggal sebelum mengirim permintaan." Problem lain tetap judul umum. CTA tetap "Kirim permintaan" (form tunggal, disengaja).
- Chip jam: bentuk radio (lingkaran indikator), 48px, border hangat; terpilih border 2px rust + latar tint + teks rust bold.
- Label "Jam baru · {zona}" bold 16px; "(opsional)" bold muted.
- Submitting: tombol disabled datar (latar netral, teks muted), tanpa spinner; teks status tetap `role="status"`.
- Rejected: hapus tautan "Ajukan jadwal lain" (mockup satu CTA).
- mock.ts: samakan fixture dengan mockup — permintaan Kamis 19 Nov 2026 19.30 WIB; jadwal awal Rabu 18 Nov 19.00 WIB; "now" demo late = Selasa 17 Nov 20.00 WIB; slot availability mock 18.30/19.00/19.30/20.00 bila mock availability milik fitur ini (jangan ubah mock fitur lain).

## P3 — `F/screens/cancel-screen.tsx`, `late-screen.tsx`, `cancelled-screen.tsx`, `recovery-screens.tsx`, katalog `reservation-guest-cancel.ts`
- Semua h1/h2/paragraf bantu pakai `F/typography.ts` (P1 paralel).
- CTA batal: variant primer rust (bukan `destructive`) — mockup.
- Label "Alasan pembatalan" bold 16px, "(opsional)" bold muted.
- Loading skeleton: warna terang (padanan `#e9dfd4`) lokal untuk halaman ini, bukan `--skeleton` global gelap.
- `invalid`: daftar bernomor rapat (leading ~20px antarbaris), teks bantu di bawah tombol jarak 8–16px, 16px.
- `cancelled`/`cancelled-late`: tombol "Periksa status pengembalian" konsisten (secondary).

## P4 — `scripts/ui-check-reservation-guest.mjs`
- State `reschedule`: pilih tanggal 2026-11-19 dan jam 19.30 (bila chip ada) + isi catatan "Ada perubahan rencana, kami ingin datang besok malam." sebelum screenshot. `validation`: tanggal lewat → kirim.
- Pastikan blur fokus/hover sebelum screenshot (mouse ke 0,0) supaya tombol tidak tertangkap hover.
