# 936 POS panel pembayaran: sisa legend-5w6 (poin, voucher, tiket fasilitas, EDC ditolak)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md dan ~/.agents/team/ui-standard.md). Opus 5.5 high. Spawn paralel dalam satu giliran: Explore (mockup + kontrak), satu implementer per bagian (file terpisah), test-writer, ui-auditor, test-runner, reviewer. Lapor sekali. Typecheck web sekali sebelum lapor.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Tanpa migrasi. Tidak merge, tidak deploy.
Sudah ada (jangan dibangun ulang): `apps/web/src/features/ws04-pos-kasir/components/payment/*` (tunai, QRIS, EDC, standalone + PIN, VA, e-wallet, split). Lihat komentar CTO di `bd show legend-5w6`.
Bangun yang belum ada, mengikuti pola panel yang ada dan mockup di `design/` (cari POS payment):
1. Panel tukar poin member (pakai endpoint loyalty yang ada; bila belum ada, mock mode + catat di CONTRACT-GAPS.md).
2. Panel voucher (masukkan/scan kode, tampil status valid/tidak, potongan dari server).
3. Jual tiket fasilitas dari POS + cetak tiket lewat Print Agent edge (pola struk 928), pakai komponen dari `features/facility` bila bisa.
4. State EDC "ditolak" eksplisit; label penyedia QRIS di layar pelanggan (DOIT) dari data, bukan teks tetap.
Jangan sampai rugi: potongan voucher/poin dan total dihitung server; UI hanya menampilkan. Tombol bayar terkunci saat permintaan berjalan (tidak dobel).
Bukti: test komponen gagal-dulu lalu hijau, teks di katalog (`node --test tests/text-contract.test.mjs`), screenshot 360px + desktop terang/gelap lewat `heavy --browser` (subagent), ui-auditor tanpa P1, pra-gate AGENTS.md.
Laporan: SHA, file utama, screenshot path, temuan auditor/reviewer, kontrak yang masih pending, angka subagent. Komentari kartu.
