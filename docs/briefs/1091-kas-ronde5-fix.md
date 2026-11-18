# Brief: engineer — fix SO kas/payout ronde 5 (tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Cabang `ghostex/cek-kas-1102-pinjaman-reimburse-supplier` (head c3d90b96b), worktree yang sama. Migrasi: 0691 saja (bila butuh dua, lapor dulu). Push tanpa `--force`.

## Masukan
Temuan: `docs/qa/second-opinion-kas-payout-ronde5-1089.md` (folder utama). Kerjakan keduanya (2 P1).

## Keputusan CTO (sudah diambil, jangan tanya lagi)
- P1-1 flip DB `settle_skipped -> settle_waived` tanpa jurnal: setiap transisi ke `settle_waived` wajib punya jurnal koreksi dengan net dan akun benar saat commit (constraint trigger deferred, pola 0400), dan transisinya hanya lewat fungsi/grant tepercaya seperti langkah payout lain (peran `legend_app` tidak bisa flip langsung). Endpoint waive pada posting yang sudah `settle_waived` tanpa jurnal: tolak 409, jangan anggap sukses. Ganti test lama `cash-1102-settle-skipped-waive-5qqb9.test.ts:988` yang mempertahankan perilaku lama. Test pakai `SET LOCAL ROLE legend_app`.
- P1-2 reversal manual jurnal pengeluaran otomatis membuka saldo: kunci reversal manual (409, kode `*_JOURNAL_LOCKED` sejenis waive) untuk jurnal pengeluaran otomatis yang mengkredit 1102 (kasbon `payroll-gl:loan:*`, reimburse tunai, settlement gaji tunai, supplier `paid`) selama sumbernya masih berstatus dibayar. Koreksi lewat alur pengembalian sumber. Pengecualian reversal sistem (void/refund, `payroll.reversed`) tetap. Aturan membatasi: bila ragu, tolak.

## Pembagian paralel
- test-writer (1): test gagal-dulu dua temuan (nama `cash-1102-1089-r*`), skenario persis dari laporan, termasuk variasi reimburse, gaji tunai, supplier.
- implementer: satu per temuan (migrasi/trigger vs service jurnal).
- test-runner: pemegang token heavy (test terarah, regresi kas 39 berkas sekali di akhir, typecheck API sekali).
- architect (effort xhigh, uang + migrasi): satu review atas diff akhir. Temuan nyata dibetulkan sebelum lapor.

## Bukti selesai
Test 1089 merah di c3d90b96b dan hijau di head; regresi kas hijau; typecheck API lulus; `db:generate` kosong sesudah migrasi 0691; architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Jangan akhiri giliran untuk "Menunggu" (founder Q10).

## Laporan
Hasil per temuan, migrasi, bukti, berkas, commit, head SHA, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
