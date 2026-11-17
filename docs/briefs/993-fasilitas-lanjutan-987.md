# 993 Fasilitas lanjutan 987: jam lewat tengah malam, unit retired, pengingat min-spend

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: reviewer sonnet (S); bila menyentuh tagihan/min-spend uang: architect high.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/987-fasilitas-4-kartu` (f9fcb4cd7; belum di m1, antre batch86). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru bila perlu 0595-0599 (nomor kerja); 987 memegang 0570.

Konteks: laporan 987 di docs/PROGRESS.md cabang itu.

Kartu (`bd show <id>`; claim dulu):
- legend-13j7i (P3): jam fasilitas lewat tengah malam: slot memakai tanggal kalender; versi jam per hari bisnis.
- legend-etawy (P3): unit fasilitas retired_at dan batas basi tiket in_use.
- legend-qr3sd (P3): pengingat min-spend untuk peserta WFC tanpa akun.

Jangan sentuh: payout (990), supplier/kas (991), akses perangkat (984), payroll, refund/charge, DOIT.

Bukti: test gagal-dulu per kartu; tiket/slot tidak dobel dan tidak hilang di batas tengah malam; min-spend tidak menagih lebih; tenant lain tidak tersentuh.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu. Lalu test-runner + reviewer (+ ui-auditor bila UI) bersamaan. Gate (#9): prettier, eslint, typecheck API (web bila tersentuh), test terarah fasilitas, text-contract bila teks UI baru, `db:generate` kosong. Satu token heavy per thread. Jangan `pnpm check`/`pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal; JANGAN akhiri giliran untuk kabar antara.

Laporan: SHA, kartu, migrasi, test, temuan review, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
