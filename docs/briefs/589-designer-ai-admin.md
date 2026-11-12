# Brief: designer (Codex) — mockup layar Pengaturan AI (legend-nnufz)

## Peran
Baca `~/.agents/team/roles/designer.md` dan ikuti `~/.agents/team/ui-standard.md`. Pola mockup proyek: lihat satu contoh di `design/mockups/backoffice/` (HTML + PNG per state).

## Layar
Halaman Kelola → "Pengaturan AI" per tenant (owner/admin tenant). Konteks keputusan: `bd show legend-nnufz legend-z83k legend-39d.8` bila tersedia; ringkasnya:
- Dua jalur provider: (a) **Login ChatGPT** lewat device code: tombol hubungkan → tampil kode + tautan `auth.openai.com/codex/device` + status menunggu; wajib centang persetujuan risiko blokir akun ChatGPT sebelum mulai; hanya owner; tombol cabut. (b) **Model kustom OpenAI-compatible**: base URL, API key (tidak pernah ditampilkan ulang, hanya 4 karakter akhir), nama model, tombol uji koneksi; setelah uji tampil kemampuan terdeteksi (jendela konteks, batas output, tools, reasoning) yang bisa di-override admin.
- Urutan cadangan: ChatGPT utama, model kustom cadangan otomatis.
- Anggaran AI bulanan tenant (default 0 = mati) dan pemakaian bulan ini.
- Keadaan global dimatikan platform (kill switch) tampil sebagai banner, semua kontrol nonaktif.
States: kosong, menunggu kode device, terhubung, gagal/kedaluwarsa, model kustom terdeteksi, dimatikan platform. Desktop 1280 dan mobile 390.

## Bukti selesai
- `design/mockups/ai/ai-settings.html` + PNG per state (desktop & mobile), dicek `ghostex visual check <file> --out <png>` (dan `--width 390`).
- Teks Bahasa Indonesia sederhana untuk pemilik outlet non-teknis. Commit + push cabang `design/ai-settings` tanpa --force. Lapor path file dan daftar state.
