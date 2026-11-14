# Review enam perbaikan UI ops dan web

Buka `review.html` di browser. Halaman mandiri, font disematkan, tanpa permintaan jaringan. Halaman belum dipublikasikan ke Ghostex. Semua perubahan terbatas di folder ini.

## Cakupan

| Kartu | Layar dan kondisi utama | Arah |
| --- | --- | --- |
| legend-lhe4k | Navigasi ops saat staf akan menjalankan checklist | Langsung kerjakan; sembunyikan entri template di navigasi |
| legend-z274 | Notifikasi checklist terlewat dan gagal | Tinjau kategori “Checklist operasional” menggantikan “Perubahan jadwal” |
| legend-1n5z | Dialog mulai checklist, tenggat melewati tengah malam | Langsung kerjakan; hitungan cutoff dan tanggal tenggat lengkap |
| legend-v99yu | Peringatan hydration saat pemuatan | Langsung kerjakan; tampilan tetap, tanpa mockup baru |
| legend-5tai0 | Pesan sukses saat aksi bawah masih diperlukan | Tinjau satu pesan di slot bawah topbar dengan ruang yang disediakan |
| legend-rxida | Pilihan masuk dengan label tombol panjang | Langsung kerjakan; label boleh membungkus dan kontrol tetap muat |

Lima kartu visual mempunyai keadaan sekarang dan usulan pada lebar asal desktop 1024 px serta ponsel 390 px. Kartu masuk juga mempunyai pasangan 320 px. Bingkai diperkecil secara proporsional mengikuti ruang review; ukuran asal tercantum. Kartu hydration hanya mempunyai catatan karena tidak memerlukan keputusan visual.

## Keputusan desain

1. Mengikuti DESIGN.md, Ops Kontras: Plus Jakarta Sans, permukaan hangat, petrol, kontrol besar; tidak membuat arah merek baru.
2. Mempertahankan istilah dan pola layar yang ada. Kategori notifikasi berubah tanpa mengarang tautan detail; dialog tetap memakai “Tanggal shift” dan memperjelas tanggal tenggat.
3. Memakai slot pesan yang mengambil ruang dalam halaman. Memindahkan toast ke bagian atas tanpa ruang akan mengulangi masalah menutupi konten.

Tiga Explore menelusuri checklist, web, dan gaya secara paralel; satu reviewer tambahan membaca hasil dengan konteks segar. Total empat subagent, puncak tiga bersamaan. Koreksi review: ikon kalender pada kategori lama, penanda navigasi Notifikasi, bobot brand 700, dan referensi baris container masuk.

## Bukti dan batas

Rekonstruksi dibaca dari kode sumber worktree berbasis milestone/m1 `b42619abc`, bukan screenshot aplikasi berjalan. Semua tugas, tanggal, jam, dan pesan hasil adalah contoh data. Cutoff 04.00 adalah contoh, implementasi wajib memakai pengaturan outlet.

Ekspor `.beads/issues.jsonl` tidak tersedia pada checkout utama maupun worktree. Cakupan enam kartu mengikuti brief; tidak menjalankan `bd`. Peran designer dan batas folder mengikuti brief, sehingga tidak mengubah aplikasi atau `docs/PROGRESS.md`.

Font Plus Jakarta Sans disematkan dari aset proyek; lisensi lengkap di `FONT-LICENSE.txt`.

## Verifikasi

Perintah screenshot menggunakan `heavy --browser ghostex visual check`. PNG awal halaman dibatasi tinggi 8000 CSS px oleh Ghostex; PNG lanjutan menangkap kartu hydration, toaster, dan masuk dengan menyembunyikan tiga kartu awal serta header/footer pada salinan sementara di `/tmp`. Pada PNG lanjutan ponsel, pasangan desktop dan pasangan lebar ponsel lain yang berulang tidak dirender agar seluruh isi kartu terlihat. PNG 390 menampilkan bingkai 390; PNG 320 menampilkan bingkai masuk 320. Isi dan CSS setiap bingkai tetap sama. Hanya `review.html` menjadi halaman review yang diserahkan.

| Lebar review | Bagian awal | Bagian lanjutan |
| --- | --- | --- |
| 1280 px | review-desktop.png | review-lanjutan-desktop.png |
| 390 px | review-mobile.png | review-lanjutan-mobile.png |
| 320 px | review-320.png | review-lanjutan-320.png |

HTML mempunyai bingkai desktop asal 1024 px; lebar 1280 px pada tabel adalah ukuran halaman review, bukan ukuran bingkai. PNG ponsel menggunakan skala perangkat 2×.

Tidak menjalankan build, test aplikasi, atau uji pengguna: hasil pekerjaan ini adalah mockup. Tidak mengklaim bug aplikasi telah diperbaiki. Audit aksesibilitas lengkap aplikasi dan reproduksi hydration tetap bagian implementasi.

## Gerbang RYUX untuk mockup

| Area | Hasil dan dasar |
| --- | --- |
| Product | PASS untuk cakupan brief enam kartu; bukti tipis dari kode dan brief, detail JSONL tidak tersedia |
| UX | PASS dari review struktur: aksi utama tetap, tenggat lengkap, pesan hasil mendapat ruang |
| UI | PASS dari review token dan gambar; task UI mengikuti Ops Kontras |
| Design system | PASS: satu aksen petrol, satu keluarga netral hangat, satu keluarga font antarmuka; radius 8/10/12/16 px untuk peran berbeda |
| Accessibility | NOT VERIFIED menyeluruh; enam pasangan warna teks terukur ≥ 4,5:1, audit aplikasi dan interaksi keyboard belum dilakukan |
| Responsive | PASS untuk halaman review 1280/390/320 pada pemeriksaan Ghostex; overflow pada bingkai sebelum masuk sengaja diilustrasikan |
| Edge cases | PASS untuk keadaan relevan brief: setelah tengah malam, toast bertumpuk, label panjang, dan hydration tanpa perubahan visual |
| Code quality | PASS untuk sintaks JavaScript dan git diff whitespace; N/A untuk test logika aplikasi karena tidak diubah |
| Visual QA | PASS setelah memeriksa PNG awal dan lanjutan; bukti render desktop dan ponsel dicatat di atas |
| Anti-slop | PASS dari review: tanpa gradien, kaca dekoratif, testimoni, atau metrik rekaan; contoh data diberi label |
| Final | NOT VERIFIED untuk aplikasi/aksesibilitas menyeluruh; keluaran mockup memenuhi cakupan brief, belum diuji pengguna |

Kontras terukur: ink/canvas 15,93:1; muted/canvas 6,24:1; putih/petrol 7,44:1; petrol/tint 6,57:1; warning/background 6,41:1; danger/background 5,87:1.

Pemeriksaan tambahan: `npm exec --yes --package=prettier@3.6.2 -- prettier --check design/mockups/ops-kecil/review.html design/mockups/ops-kecil/README.md` keluar 0; sintaks blok JavaScript lulus `new Function`; `git diff --check` bersih.

Hook Git aktif hanya memanggil `bd hooks run`. Agar mengikuti instruksi “jangan menjalankan bd”, commit dan push memakai `git -c core.hooksPath=/dev/null ...` per perintah; konfigurasi hook repo bersama tidak diubah.
