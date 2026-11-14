# 762 HRIS koreksi absen ditolak tetap terlihat (legend-nvc7)
Peran: ui-engineer (Sonnet, tugas kecil). Base: main. Cabang: ui/hris-correction-refused. Tanpa migrasi.
Keputusan sudah diambil (review Opus C11): koreksi absen offline yang ditolak server tetap di antrean, ditandai "Ditolak" dengan alasan server, dan tombol Coba lagi / Ubah / Buang. Bukan dihapus dengan toast.
Ikuti ~/.agents/team/ui-standard.md. Teks baru masuk katalog (node --test tests/text-contract.test.mjs). Test komponen/hook untuk: ditolak tetap tampil, coba lagi mengirim ulang, buang menghapus. Satu screenshot 390 dan 1280 lewat heavy.
Cari lewat Grep "correction" di apps/web/src/features (HRIS/attendance).
Aturan umum: baca berkas peranmu di ~/.agents/team/roles/ dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md (Grep judul, Read offset/limit). Kerja berat lewat `heavy`. Test bukti gagal-dulu. Satu review konteks segar (S: reviewer sonnet). Pra-gate AGENTS.md (prettier, eslint, typecheck paket tersentuh). Commit lokal, push cabang tanpa force. Jangan merge ke main, jangan deploy. Lapor: commit, test yang dijalankan, angka subagent (total, puncak bersamaan), yang belum terverifikasi.
