# 992 Payroll lanjutan 983: koreksi lembur (lock, audit, tampil di simulate)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang/gaji).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/a846fbcc` (c9c096052, 983; belum di m1, antre batch85 setelah dd932307). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru bila perlu 0590-0594 (nomor kerja).

Konteks: laporan 983 di docs/PROGRESS.md (baris "983 selesai c9c096052", keputusan: held koreksi lembur ditampilkan di simulate + UI).

Kartu (`bd show <id>`; claim dulu):
- legend-pxzhy (P2 bug): urutan lock koreksi lembur vs reversal menyebabkan deadlock 40P01 di tahun pajak sama. Samakan urutan lock; test balapan dua transaksi.
- legend-oayhe (P2): koreksi lembur yang ditahan (held) tampil di simulate payroll dan UI (keputusan CTO sudah diambil).
- legend-xrop2 (P3): query audit approve koreksi lembur tanpa batas waktu; held hanya tercatat di audit.

Jangan sentuh: payout (brief 990), supplier/kas (991), refund/charge, akses perangkat (984), DOIT, fasilitas.

Jangan sampai rugi: test bukti (1) koreksi held tidak ikut dibayar sampai disetujui, (2) tidak ada lembur dibayar dua kali atau gaji lebih bayar karena urutan lock/reversal, termasuk bersamaan, (3) simulate sama dengan hasil run, (4) tenant lain tidak tersentuh. Bila ragu: tahan pembayaran, catat untuk CTO.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh + ui-auditor (oayhe) bersamaan. Gate (#9): prettier, eslint, typecheck API dan web, test terarah payroll, teks UI baru lewat text-contract, `db:generate` kosong. Satu token heavy per thread. Jangan jalankan `pnpm check` atau `pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal; jangan akhiri giliran untuk kabar antara.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
