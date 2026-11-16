# Sub-brief 812: status bar OperationsShell ringkas di HP

Worktree: /Users/ifanshori99/Projects/legend super app/legend-25fedc57 (apps/web). Kartu legend-0xx06.

## Masalah

`apps/web/src/components/shells/operations-shell.tsx` header = 154px tinggi di 390px (3 baris: judul, badge+jam, picker+aksi), nama outlet terpotong. Desktop (>= sm, 1280px) 78px: JANGAN berubah. Kontras tombol dari 803 (border-input pada Muat ulang) tetap.

## Target (< sm saja)

Satu baris, tinggi tepat 56px (`max-sm:h-14 max-sm:py-1`, nol wrap):

- Kiri (`min-w-0 flex-1`): judul (truncate) + subtitle satu baris di bawahnya berisi `outlet · stasiun` (truncate; di HP nama outlet ikut tampil walau ada picker). Dua baris harus muat 48px: pakai leading ketat bila perlu.
- Kanan (tidak wrap): badge koneksi hanya ikon (teks `sr-only`, tetap `role="status"`), jam, tombol outlet (ikon `Store` lucide, 44x44, `aria-label` dari kunci baru), lalu `actions` slot.
- Nama staf disembunyikan di bar HP (pindah ke sheet).
- Tombol outlet membuka `Sheet side="bottom"` (apps/web/src/components/ui/sheet.tsx): `SheetHeader` + `SheetTitle` ("Outlet dan petugas"), `SheetDescription`, daftar rincian (outlet nama LENGKAP tanpa truncate, stasiun, petugas bila ada) lalu, bila ada pilihan outlet (>= 2), daftar pilih outlet (radiogroup, tiap baris min-h-12, centang di yang aktif; pilih -> panggil onChange lalu tutup sheet via `SheetClose asChild`). Satu outlet: sheet hanya rincian (bukan tombol mati).
- Desktop (>= sm): picker Select lama (`outletControl`) tampil seperti sekarang; tombol sheet `sm:hidden`. Select di HP `max-sm:hidden` (display:none, keluar dari a11y tree, jadi `getByRole("combobox",{name:"Pilih outlet"})` desktop tetap unik).
- Tombol di bar HP maks 44px (override `max-sm:size-11 max-sm:px-0`): bar 56px tidak boleh meledak karena Button density kontras 56-60px.
- Aksi slot Expo/Pickup (`apps/web/src/features/ws04-expo/components/screen-header.tsx`): di HP tombol Muat ulang jadi ikon saja 44x44 (label `max-sm:sr-only`, tetap border-input dari 803), teks "Diperbarui HH:MM" `max-sm:hidden` tetapi waktu tetap masuk `title` + aria-label tombol bila mudah; desktop tidak berubah. `ThemeToggle` (`components/layout/theme-toggle.tsx`) juga maks 44px di HP bila perlu.

## Pembagian berkas

- operations-shell.tsx: header + sheet baru (prop baru `outletSheetControl?: ReactNode` = isi daftar pilih outlet; `outletControl` tetap untuk desktop).
- outlet-picker.tsx: tambah `OutletList` (radiogroup, tombol, memakai `SheetClose asChild`), bukan mengubah `OutletPicker`.
- area-frame.tsx (`OperationsFrame` dan blok `outletPicker`, baris ~263-395): ops shell mendapat `outletControl` dengan `className="max-sm:hidden"` (gantikan `max-sm:w-full`) dan `outletSheetControl={<OutletList .../>}`; Kelola (management shell) tetap pakai OutletPicker lama tanpa perubahan.
- screen-header.tsx (ws04-expo): aksi kompak HP.
- Teks baru ke `packages/shared/src/i18n/messages/id.ts` di `area.ops`: `outletButton: "Outlet {name}, buka rincian"`, `sheetTitle`, `sheetDescription`, `sheetOutlet`, `sheetStation`, `sheetStaff`. Jangan teks literal di JSX (`tests/text-contract.test.mjs`).
- Test: perbarui `tests/operations-screen-slot.test.mjs` (stub Sheet via registerHooks seperti stub lain bila perlu) dengan test: shell tanpa outlet picker tetap tampil judul/aksi; ada `outletSheetControl` -> tombol outlet ber-aria-label + isi sheet dirender; header HP punya kelas tinggi satu baris (`max-sm:h-14`).

## Aturan

- Tailwind v4, token proyek, tanpa warna baru. Kontras 803 tetap. Gerak: tidak ada tambahan.
- Jangan sentuh logika sesi/outlet, API, layar lain, alarm panik.
- Jangan jalankan tsc/vitest/build/playwright (token heavy dipegang test-runner). Tes terarah `node --test` tidak perlu; test-runner yang menjalankan.
- Lapor: daftar berkas diubah + keputusan yang menyimpang dari brief.

## Putaran 2 (temuan ui-auditor, kerjakan semua)

1. screen-header.tsx: waktu "Diperbarui" harus tetap terlihat di HP: tambah `<p role="status" className="text-sm leading-5 text-muted-foreground tabular sm:hidden">{updatedLabel}</p>` di `<header>` isi (setelah intro). `<p>` bar tetap `max-sm:hidden`.
2. operations-shell.tsx: jam HP `max-sm:text-sm`; phoneSubtitle `text-sm leading-4`; gap kluster kanan HP `max-sm:gap-1.5`; badge HP `max-sm:px-1.5`. Pastikan tetap muat 40px tinggi teks.
3. Muat ulang `loading` di HP: spinner + ikon melewati 44px (button.tsx loading menambah LoaderCircle). Sembunyikan RotateCw saat busy di HP (cek button.tsx; pakai kelas atau render kondisional lewat state `manual === "busy"`).
4. id.ts: `sheetDescription` netral ("Rincian tempat kerja Anda saat ini."), `outletButton` -> "Rincian outlet {name}".
5. outlet-picker.tsx OutletList: onClick tidak memanggil onChange bila baris aktif; span nama `min-w-0 break-words`.
6. theme-toggle.tsx: kembalikan ke aslinya (hapus max-sm:size-11); pasang className `max-sm:size-11` dari pemanggil di area-frame.tsx OperationsFrame (ThemeToggle harus menerima className; jika belum, tambahkan prop className saja).
7. Perbarui test yang terkena. Jangan jalankan tsc/vitest/playwright.
