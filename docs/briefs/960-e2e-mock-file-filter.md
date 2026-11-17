# 960 Tooling: test:e2e:mock menerima daftar berkas (kartu S)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Codex gpt-6.1-sol effort medium. Codex tidak menjalankan bd: CTO yang memindah kartu.
Cabang: worktree-mu dari `origin/milestone/m1` (0c31ff40e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Tanpa migrasi.
Kartu legend-1ek1l: `pnpm run test:e2e:mock -- e2e/x.mock.spec.ts` sekarang menjalankan seluruh suite mock (1,2 jam). Betulkan skrip (package.json root dan skrip pembungkusnya) agar argumen berkas diteruskan ke Playwright; tanpa argumen tetap menjalankan semua. Catat cara pakainya di `docs/local-development.md` atau dokumen test yang sudah ada.
Jangan sentuh berkas spec e2e (thread 953 sedang membetulkannya).
Bukti: jalankan satu spec mock kecil lewat `heavy` dan tunjukkan hanya berkas itu yang jalan; test kontrak root yang menyentuh skrip (bila ada) hijau; prettier dan eslint pada berkas berubah.
Laporan: SHA, berkas berubah, bukti run terarah (jumlah test dan durasi). Lapor sekali di akhir.
