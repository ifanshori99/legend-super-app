# Mockup Pengaturan AI — legend-nnufz

Tugas dari CTO: HTML statis interaktif `ai-settings.html`, PNG setiap keadaan pada 1280 dan 390. Scope designer hanya `design/mockups/`. Tidak mengubah aplikasi atau layanan, tidak membuka login nyata, tidak membuat biaya. Cabang `design/ai-settings`, commit dan push biasa di akhir.

## Dasar dan arah

Ikuti `~/.agents/team/ui-standard.md` dan RYUX. Contoh yang diminta ada di checkout utama `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/backoffice/integrasi-5tewu.html` dan `settings-hub-j0kd.html`; belum ada di checkout tugas. Arah sudah ditentukan brief: lanjutkan pola backoffice, tidak membuka pemilihan arah baru. Font lokal `../assets/plus-jakarta-sans-latin.woff2` tersedia dari folder AI. Warna netral hangat, satu CTA teal #0f5e68, sidebar 240px desktop, topbar72px, padding32px desktop /16px mobile, kartu putih solid radius12px. Body mobile 16px. Tidak perlu gambar generatif karena deliverable berupa HTML form dan PNG hasil render.

## Isi dan perilaku wajib

- Kelola → Pengaturan AI, berlaku per tenant. Bahasa Indonesia untuk pemilik outlet non-teknis. Mockup dan semua nilai contoh ditandai jelas.
- Login ChatGPT utama. Hanya owner/pemilik boleh memulai dan mencabut. Checkbox wajib dengan teks lugas risiko akun ChatGPT diblokir; awal tidak dicentang dan Hubungkan disabled. Setelah centang tombol aktif. Menunggu: kode contoh, tombol salin, link tepat https://auth.openai.com/codex/device dan instruksi buka/login/masukkan kode. Status menunggu, batalkan. Terhubung: status dan Cabut koneksi dengan konfirmasi dialog native. Admin dapat lihat status tetapi koneksi/pencabutan nonaktif dengan alasan. Jangan menampilkan token.
- Model kustom OpenAI-compatible: base URL, API key input password kosong (nilai tersimpan hanya `•••• ab12` di teks, tanpa full key di DOM), nama model, Uji koneksi. Sukses menampilkan kemampuan terdeteksi: konteks, output maksimal (token dijelaskan sebagai potongan teks), tools dan reasoning dengan penjelasan sederhana; admin bisa override lewat details Terapan lanjutan. Beri label sumber deteksi dan nilai contoh, bukan klaim metadata nyata. Thinking dipilih otomatis oleh sistem, tidak beri pilihan level baru.
- Urutan cadangan tetap: 1 ChatGPT utama → 2 Model kustom otomatis bila utama bermasalah. Status belum siap bila cadangan kosong; tidak membuat toggle urutan.
- Anggaran bulanan tenant default Rp 0 = AI mati, pemakaian bulan ini; tersedia simpan anggaran; contoh tersimpan aktif boleh Rp 500.000 dan pemakaian Rp 125.000 dari kontrak 80% peringatan /100% berhenti. Tidak ada tarif atau harga provider karangan.
- Kill switch platform: banner menonjol; semua kontrol pengaturan disabled termasuk checkbox, input, uji, simpan, cabut, link device. Navigasi dan kontrol tinjau mockup boleh tetap aktif. Gunakan fieldset disabled dan cegah link/action lewat kode.
- State via ?state=empty|device|connected|failed|expired|detected|disabled; ?role=owner|admin. `const INITIAL_STATE = 'empty';` dipakai render script mengganti fallback saat membuat HTML sementara. Semua aksi mockup lokal, sertakan keterangan tidak menghubungi layanan.
- Validasi inline, feedback simpan/uji/salin, status aria-live, focus-visible, form labels, prefers-reduced-motion, tanpa overflow 320px. Interaksi uji boleh simulasi terdeteksi dengan keterangan simulasi. Halaman default empty.

## Pembagian kerja

Subagent designer_source: hanya ai-settings.html. Induk: render script, README AI, indeks README, PNG, hasil pemeriksaan. Reviewer read-only setelah sumber siap. Jangan edit di luar scope atau jalankan git commit/push dari subagent.

## Pilihan struktur

Dipilih satu alur form vertikal dengan ringkasan anggaran/cadangan di sisi desktop, lalu menumpuk pada mobile. Alternatif tab provider menyembunyikan cadangan; dua provider setara mengaburkan urutan utama. Mengikuti satu contoh backoffice (bukti tipis untuk struktur), brief langsung kuat untuk aturan produk. Data kapasitas, tanggal, kode, nama model, anggaran/pemakaian semuanya ilustrasi, bukan hasil koneksi nyata.

## Bukti dan batas

Render wajib `heavy ghostex visual check <html> --width 1280 --out <desktop.png>` dan `--width 390 --out <mobile.png>` per keadaan. Semua PNG dibuka dan diaudit; pemeriksaan keyboard/responsif/mask key/kill switch via Chromium bila tersedia, lewat heavy. Tidak perlu setup DB/build/test aplikasi untuk artefak desain statis. Laporan tidak mengklaim OAuth/provider sungguhan teruji. CTO menangani status kartu Beads sesuai aturan tim Codex.
