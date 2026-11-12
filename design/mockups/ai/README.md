# Pengaturan AI tenant

Mockup untuk review `legend-nnufz`, mengikuti keputusan `legend-z83k` / Q88 dan kemampuan model `legend-39d.8`. Sumber: [ai-settings.html](ai-settings.html). Ini artefak desain statis; seluruh kode perangkat, model, kapasitas, nominal, dan status adalah **contoh**, tanpa panggilan layanan AI atau transaksi.

## Layar dan kondisi

Tujuan pemilik: menghubungkan akun ChatGPT dengan persetujuan risiko, menyiapkan model cadangan, dan membatasi pemakaian anggaran AI tenant. Admin tenant dapat mengelola model kustom dan anggaran; koneksi ChatGPT hanya milik pemilik.

| State URL | Kondisi | Desktop 1280 | Mobile 390 |
| --- | --- | --- | --- |
| `?state=empty` | Belum terhubung, persetujuan belum dicentang, anggaran Rp 0 | [PNG](ai-settings-empty-desktop.png) | [PNG](ai-settings-empty-mobile.png) |
| `?state=device` | Kode perangkat contoh dan tautan login, menunggu persetujuan | [PNG](ai-settings-device-desktop.png) | [PNG](ai-settings-device-mobile.png) |
| `?state=connected` | ChatGPT terhubung, aksi cabut dengan konfirmasi | [PNG](ai-settings-connected-desktop.png) | [PNG](ai-settings-connected-mobile.png) |
| `?state=failed` | Koneksi gagal, pemulihan dengan mencoba kembali | [PNG](ai-settings-failed-desktop.png) | [PNG](ai-settings-failed-mobile.png) |
| `?state=expired` | Kode kedaluwarsa, buat kode baru setelah persetujuan | [PNG](ai-settings-expired-desktop.png) | [PNG](ai-settings-expired-mobile.png) |
| `?state=detected` | Model cadangan teruji dalam simulasi, kemampuan dan pengubahan manual | [PNG](ai-settings-detected-desktop.png) | [PNG](ai-settings-detected-mobile.png) |
| `?state=disabled` | Platform mematikan AI, banner dan semua kontrol pengaturan nonaktif | [PNG](ai-settings-disabled-desktop.png) | [PNG](ai-settings-disabled-mobile.png) |

Tambahkan `&role=admin` untuk meninjau pembatasan koneksi ChatGPT dari akun admin. Tanpa parameter, halaman membuka state kosong sebagai pemilik. Uji pada mockup hanya memindahkan tampilan lokal; hasilnya bukan bukti koneksi penyedia berhasil.

## Tiga keputusan desain

1. **Hubungan utama dan cadangan terlihat bersama.** ChatGPT lebih dahulu; model kustom berikutnya. Ringkasan mengunci urutan ChatGPT → model kustom otomatis. Alternatif tab menyembunyikan kesiapan cadangan; dua pilihan setara mengaburkan prioritas yang sudah ditentukan brief.
2. **Persetujuan risiko berada tepat sebelum aksi.** Checkbox belum dicentang, tombol hubungkan belum aktif, tautan perangkat hanya muncul pada tahap menunggu. Pemilik mendapat tombol cabut dengan konfirmasi; admin melihat alasan pembatasannya. API key lama tidak diisi kembali ke form.
3. **Informasi teknis muncul setelah diperlukan.** Base URL, API key, dan nama model cukup untuk mulai; konteks, batas output, tools, serta reasoning diterangkan dengan bahasa sederhana pada hasil uji. Pengubahan manual tetap tersedia untuk admin. Anggaran Rp 0 dan banner platform menjelaskan alasan AI mati.

## Arah visual dan bukti

Mengikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`, serta satu pola backoffice yang dibaca dari checkout utama: `design/mockups/backoffice/integrasi-5tewu.html` dan halaman hub pengaturan. Folder contoh belum berada pada commit dasar worktree ini. Bukti visual struktur terbatas pada contoh tersebut; aturan peran, risiko, cadangan, anggaran, dan kill switch berasal langsung dari brief/keputusan produk.

Warna aksi petrol, netral hangat, Plus Jakarta Sans dari aset lokal disematkan sebagai data font dalam HTML, permukaan solid. Font mengikuti lisensi [OFL proyek](../assets/FONT-LICENSE.txt). Desktop memakai sidebar dan panel ringkasan; mobile satu kolom dengan label tetap terlihat dan kontrol sentuh. Tidak ada foto, gambar generatif, tarif penyedia, klaim gratis, atau invoice contoh. Angka penggunaan disebut perkiraan, bukan biaya aktual penyedia.

## Menghasilkan ulang

Dari root worktree, jalankan:

```sh
heavy node design/mockups/ai/render.mjs
heavy node design/mockups/ai/verify.mjs
```

`render.mjs` membuat HTML sementara tiap state, menjalankan `ghostex visual check <html> --width 1280 --out <png>` dan `--width 390`, lalu menghapus HTML sementara. Perintah dan keluaran tersimpan di [render-results.json](render-results.json). PNG mencakup halaman lengkap agar form di bawah lipatan tetap dapat diperiksa.

`verify.mjs` memakai Playwright 1.63.0 yang sudah terpasang pada checkout ini atau checkout utama saudara `../legend`; tidak membuat symlink `node_modules` atau menjalankan aplikasi. Bila lokasi berbeda, atur `LEGEND_PLAYWRIGHT_MODULE` ke modul Playwright terpasang. Hasil pemeriksaan disimpan di [verification.json](verification.json).

## Hasil pemeriksaan — 13 November 2026

- Ghostex: **14/14** state × lebar menyatakan `Fits`, tanpa peringatan keluar layar. Perintah menggunakan viewport desktop 1280 dan mobile 390; Ghostex mengekspor mobile pada kepadatan 2× sehingga berkas PNG selebar **780 piksel**. Desktop diekspor 1280 piksel. Seluruh halaman, termasuk area di bawah lipatan, ikut diekspor.
- Chromium: **25 pemeriksaan** lulus: 21 kombinasi state/lebar 1280, 390, 320; persetujuan pemilik sebelum login; larangan login/cabut untuk admin; dialog pencabutan dapat dibatalkan; fokus keyboard terlihat. Semua key tersimpan tidak diisi kembali; kill switch menonaktifkan kontrol pengaturan. Tidak ada error runtime atau permintaan jaringan eksternal.
- Inspeksi visual: designer membuka tujuh PNG desktop; reviewer konteks segar membuka tujuh PNG mobile. Temuan tautan ganda, tampilan disabled, border input, validasi blur, dan teks status sudah diperbaiki. Reviewer tidak menemukan blocker pada ekspor akhir.
- Kontras pasangan utama dihitung dari sRGB: teks utama/putih **17,21:1**, teks bantu/putih **6,74:1**, CTA putih/petrol **7,44:1**, border input/putih **3,66:1**, teks status sukses **6,35:1**, peringatan **8,04:1**, error **8,50:1**. Ini pemeriksaan pasangan sumber, bukan audit aksesibilitas lengkap.
- `node --check` untuk script render, script audit, dan JavaScript inline lulus; `git diff --check` bersih. Build/test aplikasi tidak relevan karena hanya artefak desain statis yang berubah.

| Gate RYUX | Hasil dan batas |
| --- | --- |
| Product | PASS pada lingkup mockup: brief langsung, keputusan Q88, kontrak anggaran. Belum diuji pengguna. |
| UX | PASS rancangan: utama/cadangan terlihat, risiko sebelum aksi, alasan disabled dan pemulihan jelas. |
| UI | PASS pada kanvas: task UI, arah backoffice yang sudah ada, tanpa eksplorasi merek baru. |
| Design system | PASS: satu aksen petrol, satu keluarga netral hangat, warna status terpisah; radius 4 untuk meter, 6 untuk label tinjau/status, 8 untuk kontrol, 12 untuk kartu/dialog, lingkaran nomor/status. Satu ukuran judul utama tiap viewport, satu keluarga font, penanda status teks konsisten, 0 emoji, 0 gradien. |
| Accessibility | NOT VERIFIED secara lengkap: pasangan kontras dan fokus keyboard diperiksa; axe dan pembaca layar belum dijalankan. |
| Responsive | PASS pada 1280, 390, 320: tanpa overflow horizontal; semua state ditinjau secara geometri. Zoom 200% belum diuji. |
| Edge cases | PASS pada tujuh state yang diminta; izin admin diperiksa melalui parameter role. |
| Code quality | N/A untuk produk; sumber mockup lolos sintaks dan audit browser. |
| Visual QA | PASS: 14 ekspor Ghostex dan seluruh PNG dibuka oleh designer/reviewer. |
| Anti-slop | PASS lingkup mockup: data contoh ditandai, tanpa harga/layanan atau klaim baru. |
| Final | NOT VERIFIED sebagai produk; artefak desain siap untuk review melalui CTO. |

Pekerjaan dibagi ke empat subagent Codex: dua penelusuran, satu penulis HTML, satu reviewer. Laporan biaya dan rata-rata paralel dari alat tim belum tersedia untuk sesi Codex ini (`session-usage`: transkrip tidak ditemukan; `parallel-report`: tidak ada sesi). Tidak mengubah `docs/PROGRESS.md` karena batas peran designer hanya `design/mockups/`.

## Batas bukti

Ini rancangan untuk review founder melalui CTO. Tidak ada perubahan aplikasi, migrasi, login OAuth asli, penagihan, atau koneksi model sungguhan. Audit produksi seperti Lighthouse, axe aplikasi, dan pengujian pembaca layar tetap milik tahap implementasi. Status kartu Beads ditangani CTO sesuai aturan peran Codex.
