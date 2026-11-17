# 998 Second opinion supplier dan payout (uang + migrasi; gerbang rilis area supplier/payout)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree (disk sempit): pakai `git diff`/`git show <ref>:<path>` dari folder utama, jangan checkout.
Diff (berurutan):
(1) `git diff origin/milestone/m1...origin/ghostex/991-bayar-supplier-approval-kas` (tip bbcf73dee; base m1; migrasi kerja 0585, 0586, 0587; 0586/0587 tanpa snapshot).
(2) `git diff origin/milestone/m1...origin/ghostex/92055877` (ghostex/92055877 tip b861737be, plus lanjutan terbaru di cabang yang sama; migrasi 0580-0583, klaim lama diblok 0583; cek tip terbaru dengan `git log` sebelum review).
Kartu: legend-xxqz3, legend-a4z2f, legend-4qowr, legend-efdx6, legend-eestb (991); kartu 990 xbagc, d9pxr, y2lk2, r8nas, nsqhm, w9od2 (0584), legend-7hg1q (gerbang).
Diterima CTO (jangan dilaporkan): clearance terikat sidik bukti (berubah = buka ulang); password tanpa MFA diterima; batas kebijakan default 0 pada seed/backfill sengaja.
Cari: pembayaran supplier melebihi sisa tagihan (pending mengurangi sisa, batas kumulatif, dua permintaan bersamaan); approval yang bisa dilewati atau disetujui pembuatnya sendiri; default batas 0 yang membuka pembayaran ketika kebijakan belum ada; rekon kas kecil vs GL 1102 yang salah per entity; jurnal dobel saat journalize diulang; cash_out di inbox approval yang bocor lintas tenant; klaim lama yang masih bisa dipakai setelah 0583; migrasi tidak idempoten atau mematikan RLS/FORCE.
Usul test: dua pembayaran pending bersamaan terhadap satu tagihan, approve oleh pembuat, journalize dua kali, klaim lama setelah 0583.
Hasil: tulis `docs/qa/second-opinion-supplier-payout.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain. Lapor hanya saat selesai.

Tambahan CTO 17 Nov: tip final 990 = `ghostex/92055877` 74e142d8b (migrasi kerja 0580-0584, clearance fingerprint, fee tersegel).
