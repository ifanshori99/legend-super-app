# 906 VA: jalur keluar staf untuk kode expired tanpa jawaban final penyedia (legend-5wn1e)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang + akses: architect effort xhigh. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore jalur force release QR Q93 + kode VA live, test-writer gagal-dulu, implementer, test-runner, lalu 1 architect xhigh).
Cabang: worktree-mu dari `fix/qris-hold-so-879` (785b3b453); push cabang baru `fix/va-staff-exit-5wn1e` tanpa force. Migrasi (bila perlu) sementara mulai 0390; merge train menomori ulang. Tidak merge, tidak deploy.
Masalah: sejak 896, kode failed/expired hidup sampai penyedia menjawab final atau rekonsiliasi. Kode VA yang penyedianya tidak pernah menjawab final mengunci order selamanya. QR sudah punya force release (Q93); VA belum.
Yang dibangun (meniru Q93, aturan paling membatasi):
- Aksi staf "lepas kode VA" untuk kode expired lokal tanpa jawaban final: izin RBAC sama dengan force release QR, password step-up, alasan wajib, audit row.
- Sebelum lepas: tanya status penyedia sekali; paid -> catat/parkir lewat jalur biasa (bukan lepas). Error/pending -> boleh lepas.
- Setelah lepas: kode masuk antrean rekonsiliasi (bukan final); uang yang datang belakangan dicatat sebagai dana terparkir tepat sekali (memblokir tender baru sesuai 896), tidak hilang dan tidak membuat order lunas dua kali.
Bukti selesai: test gagal-dulu lalu hijau (lepas tanpa izin/step-up ditolak; lepas saat penyedia jawab paid ditolak; paid susulan setelah lepas tercatat/parkir tepat sekali; order tidak bisa dibayar dua kali), test terarah area QRIS/VA hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api+web, teks UI ke katalog bila ada, `db:generate` kosong), architect xhigh tanpa P1.
Laporan: SHA, hasil test, temuan architect, angka subagent (total, puncak bersamaan). Komentari kartu legend-5wn1e.
