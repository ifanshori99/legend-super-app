# Audit UI pemilih outlet (ebt9f/2aqp), ui-auditor 10 Nov

Dua temuan nyata menengah (kilas outlet salah saat muat, jalan buntu di keadaan 0 outlet), sisanya kecil. Ini bukan layar baru yang perlu review founder. Satu tambahan: 0 outlet adalah layar baru kecil, jadi lihat dulu screenshot-nya setelah aksi ditambah.

Saya membaca diff `edf04d3e` dan keempat screenshot. Branch tidak saya jalankan. Screenshot keadaan 0 outlet tidak ada, jadi bagian itu saya nilai dari kode saja.

## Masalah nyata, urut berat

1. **`area-frame.tsx` (AreaFrame, efek `savedId`): kilas outlet salah saat muat.**
   - Render pertama selalu memakai outlet pertama. `readSavedOutletId()` baru jalan setelah hidrasi, lalu `FloorBoardPage` di-remount lewat `key`.
   - Staf yang terakhir memilih outlet B melihat papan outlet A lebih dulu, dan request ke outlet A ikut terkirim. Itu terjadi di setiap muat ulang.
   - Ini rawan di layar tulis (POS, bayar): aksi bisa mendarat di outlet yang salah.
   - Dampak pengguna: kasir melihat data outlet yang salah selama sekejap, dan bisa menekan tombol di dalamnya.
   - Perbaikan: tahan render layar outlet (skeleton shell) sampai pilihan tersimpan terbaca, atau baca localStorage lewat `useSyncExternalStore` dengan snapshot server `null`. Tahan hanya children; shell tetap tampil.

2. **`area-frame.tsx:~190-220`, keadaan 0 outlet: jalan buntu.**
   - `EmptyState` tanpa `action`. Standar, bagian "Kondisi layar": kosong wajib punya penjelasan dan aksi berikut.
   - Shell operasi tidak punya tombol keluar, sehingga pengguna tidak punya jalan lain.
   - Teks "Hubungi pemilik/manajer" tidak membantu pemilik tenant baru yang justru 0 outlet. Komentar kode bilang tenant baru membuat outlet pertamanya di Kelola, tapi tidak ada tautan ke sana.
   - Perbaikan: beri `action`. Jika akun punya izin kelola, tombol "Buka Kelola" ke area manajemen untuk membuat outlet. Jika tidak, tombol "Kembali ke beranda" plus "Keluar" (`SignOutButton`). Ganti teks hint menjadi kalimat yang menyebut siapa dan apa: "Minta pemilik atau manajer menugaskan akun Anda ke outlet."

3. **`area-frame.tsx` (`actions` shell manajemen): picker mungkin tampil di layar yang tidak membacanya.**
   - Picker tampil di topbar manajemen untuk 2+ outlet. Beberapa layar Kelola membawa pemilih outlet sendiri (`ws02-devices/components/enroll-dialog.tsx`, `ws07-cash-bank/components/cash-deposit-dialog.tsx`).
   - Beberapa layar lain hanya membaca `timeZone` dari konteks (kampanye, stok).
   - Hasilnya ada dua pemilih outlet yang bisa berbeda nilai, atau kontrol yang tidak mengubah apa pun. Standar: tidak ada kontrol mati.
   - Perbaikan: tampilkan picker hanya di layar yang benar-benar memakai outlet konteks. Contohnya lewat flag di definisi nav atau area. Atau terapkan hanya di shell operasi untuk sekarang, dan catat sisanya sebagai kartu lanjutan.
   - Saya tidak memeriksa tiap layar Kelola, jadi cakupan pastinya perlu dicek oleh engineer.

4. **`operations-shell.tsx` header + `outlet-picker.tsx:27`: header tinggi di 390px.**
   - `outlet-picker-390.png` menunjukkan header sekitar 245px dari 844px (29% layar). Badge dan jam satu baris, picker satu baris, ikon tema sendirian di baris ketiga.
   - `390-first` sekitar 170px, juga tinggi. Itu mengurangi ruang kerja kasir di layar kecil.
   - Perbaikan: di bawah `sm`, taruh picker dan ikon tema dalam satu baris (`flex-1 min-w-0` untuk picker). Atau tampilkan outlet aktif sebagai trigger-nya sendiri dan hapus baris subjudul "Cafe Legend Bandung · station".

5. **`outlet-picker.tsx:27`: lebar trigger tidak dibatasi.**
   - `w-auto min-w-40` tanpa `max-w`. Nama outlet panjang melebarkan trigger melewati 320px. Standar: lebar 320px tanpa scroll horizontal.
   - Perbaikan: tambah `max-w-full`; `truncate` sudah ada di span anak.
   - Belum saya verifikasi di 320px. Tes di viewport itu dengan nama 60 karakter.

## Kecil dan selera

6. Nama outlet muncul tiga kali di 390px: subjudul shell, trigger picker, dan `PageHeading outlet` di papan meja. Dengan picker tampil, subjudul shell dan heading itu berulang. Hapus salah satunya saat picker aktif (selera).
7. Tidak ada umpan balik setelah ganti outlet selain remount papan. Tambah `aria-live="polite"` pendek, misalnya "Outlet diganti ke X". Papan memang tampil skeleton lagi, jadi ini peningkatan saja.
8. `outlet-picker-390.png` dan `1280.png`: papan outlet kedua menampilkan "Denah meja tidak dapat dimuat — periksa koneksi ke edge node". Ini kemungkinan celah fixture mock untuk "Bandung 2", bukan cacat UI. Pastikan fixture menyediakan papan untuk outlet kedua supaya demo `?outlets=many` tidak menyesatkan.
9. Label aksesibel `area.outletPicker` = "Outlet" sudah ada dan cukup. Taste: "Pilih outlet" lebih jelas untuk pembaca layar.

## Lulus

- Kontras (`contrast-check`): chevron/teks muted `#5f5b55` di `#ffffff` 6,74:1 dan di `#faf8f5` 6,36:1; dark `#aaa59d` di `#0f0e0d` 7,88:1. Batas kolom `--input` light 3,66:1 dan dark 4,34:1, memenuhi 3:1 untuk komponen UI.
- Target sentuh: `h-control` 60px (Kontras), 36px mouse atau 44px sentuh (Padat). Lulus.
- Fokus: ring terlihat di screenshot. Trigger memakai `fieldClass` dengan `focus-visible:shadow-focus`.
- Nama aksesibel ada lewat `aria-label`. Ikon chevron `aria-hidden`.
- Komponen pakai Radix Select lewat shadcn (tidak membuat focus trap sendiri). Ikon Lucide diizinkan.
- Picker hanya muncul untuk 2+ outlet (kondisi `outletChoice`), jadi tidak ada kontrol sia-sia untuk 1 outlet. Papan di-key per outlet, jadi zona dan meja tidak bocor antar outlet.
- Tidak ada glass, glow, gradien, emoji, atau data karangan.

## Soal review founder

Ini perubahan kecil pada layar yang sudah disetujui. Picker adalah satu kontrol di chrome yang ada, dan keadaan 0 outlet memakai komponen `EmptyState` bawaan. Audit ini cukup. Tidak perlu gerbang review founder, dengan syarat temuan 1 dan 2 dibetulkan sebelum merge.

Temuan 3 adalah keputusan cakupan teknis (di layar mana picker tampil), bukan visual, jadi tetap keputusan tim.

File yang diaudit (worktree `ws/ebt9f-me-outlets`):
- `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ebt9f-me-outlets/apps/web/src/components/layout/outlet-picker.tsx`
- `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ebt9f-me-outlets/apps/web/src/components/layout/area-frame.tsx`
- `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ebt9f-me-outlets/apps/web/src/components/shells/operations-shell.tsx`
