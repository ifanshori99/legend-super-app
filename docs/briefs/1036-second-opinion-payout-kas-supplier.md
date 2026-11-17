# 1036 Second opinion: payout recon 990 + kas/supplier 991 (gerbang rilis, sudah di m1 8f544e5ea)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout.
Diff A (990 payout recon): `git diff 1b0fd2a9e...origin/ghostex/92055877 -- . ':!**/meta/*snapshot.json'` (brief: docs/briefs/990-payout-recon-lanjutan.md).
Diff B (991 kas + bayar supplier approval): `git diff 1b0fd2a9e...origin/ghostex/991-bayar-supplier-approval-kas -- . ':!**/meta/*snapshot.json'` (brief: docs/briefs/991-akuntansi-kas-supplier.md).
Catatan merge train batch86: migrasi dinomori ulang di m1 (990 = 0460-0464, 991 = 0465-0467); 0463 diubah menjadi cek per tenant dan 0459 NO FORCE/FORCE RLS. Periksa versi m1: `git show origin/milestone/m1:<path>`.
Diterima CTO (jangan dilaporkan): P3 yang tercatat "accepted" di cabang 990; founder Q27 (supplier wajib 2 orang).
Cari: payout ganda atau lebih bayar, fee/jurnal salah, klaim return tanpa referensi bank, approval kas/supplier yang bisa dilewati (satu orang, tingkat terlewat, threshold), jurnal kas/GL tidak sama dengan uang nyata, lintas tenant/outlet, race/lock, migrasi yang merusak data lama.
Hasil: tulis `docs/qa/second-opinion-payout-kas-1036.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain. Lapor hanya saat selesai.
