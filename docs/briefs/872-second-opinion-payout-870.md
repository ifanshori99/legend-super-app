# 872 Second opinion ulang: perbaikan payout 870 (legend-7t2vv)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Menyentuh uang dan migrasi: effort xhigh. Read-only, tanpa edit kode produk.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Jangan checkout di folder utama; baca lewat `git show`/`git diff` atau buat worktree sendiri.
Cakupan: `git diff origin/ghostex/pemindai-bersama-bukti-payout-m6...origin/fix/payout-second-opinion-870` (tip 9f75ea558). Konteks temuan awal: `docs/qa/second-opinion-payout.md` (2aspe settle tertunda, yjbjb ekspor lama ditutup, w3691 claim bukti return; migrasi 0368 tabel `payroll_payout_return_claims`).
Cari: apakah ketiga temuan benar tertutup; settle_pending yang bisa macet selamanya, diselesaikan dua kali, atau ke rekening salah; claim bukti yang bisa dilewati lewat jalur lain (resolve, konfirmasi, batch susulan) atau balapan dua operasi paralel; jalur lain yang masih membuat instruksi pembayaran bank tanpa batch disetujui; trigger/RLS migrasi yang bisa ditulis lintas tenant; pihak dibayar lebih atau outlet rugi.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: tulis `docs/qa/second-opinion-payout-870.md` di worktree-mu (P0-P3, berkas:baris, skenario gagal konkret, usul test). Lapor hanya saat selesai: ringkasan, path laporan, cabang/commit.
