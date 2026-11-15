# Brief: engineer — sisa GL payout setelah 870 (legend-1t65x, legend-vvzij)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri dari `origin/fix/payout-second-opinion-870` (0173623ed). Cabang baru: `fix/payout-gl-877`.

## Tujuan
Aturan founder jangan sampai rugi: pembukuan payout harus cocok dengan uang yang bergerak.
- `legend-1t65x` (dari review architect xhigh atas 870):
  1. `payroll-payout-gl.service.ts:467`: batch kedua yang jadi pending saat akuntansi mati tidak pernah menjurnal biaya bank (`fee_posted` tetap true). Keputusan CTO: biaya ikut diposting saat `resolvePendingSettles` menyelesaikan pending (atau `feePosted=false` saat pending), tepat sekali.
  2. `payroll-payout-manual.service.ts:754-755`: urutkan fingerprint sebelum mengambil proof lock agar dua konfirmasi dengan berkas sama urutan terbalik tidak deadlock (40P01).
  3. Komentar header `payroll-payout-gl.service.ts:41` disesuaikan (posting kas lama gagal tertutup 409).
- `legend-vvzij`: serah terima tunai saat akuntansi mati final `settle_skipped`; bila akuntansi dinyalakan sebelum consumer lock berjalan, jurnal lock terposting dan utang gaji (2103) batch itu tetap terbuka tanpa jalur perbaikan. Keputusan CTO: perlakukan sama dengan F1 870 — consumer lock yang memposting jurnal lock untuk run yang punya `settle_skipped` dari serah terima nyata mengubahnya jadi settle (idempoten, akun sumber beku), atau tolak memposting lock tanpa menyelesaikan settle. Pilih yang paling sederhana dan tulis alasannya.

## Kartu
`legend-1t65x`, `legend-vvzij`: in_progress di awal, review saat lapor, beri komentar.

## Scope
Hanya service payout/GL payroll, consumer GL payroll, test API terkait. Migrasi hanya bila benar perlu (nomor sementara 0620-0621). Jangan UI.

## Pembagian paralel
test-writer test gagal-dulu per butir; implementer per berkas (gl.service vs manual.service); satu test-runner pemegang heavy; satu architect xhigh atas diff.

## Bukti selesai
Test merah di 0173623ed lalu hijau; test payout 870 + GL terarah tetap hijau (`LEGEND_TEST_FILES="src/test/..." heavy pnpm test` dari root worktree). Pra-gate AGENTS.md, typecheck API. Commit, push tanpa force, jangan merge. Lapor sekali di akhir (jangan akhiri giliran untuk kabar antara).
