# Brief: engineer — pembayaran gaji: inti + kanal manual bank (BCA)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang/gaji: "jangan sampai rugi" wajib dibuktikan (tidak ada karyawan dibayar dua kali atau lebih dari gaji bersih; tidak ada item hilang).

## Desain
`docs/design/payroll-disbursement.md` (commit 782738a9e). Ikuti, kecuali keputusan founder berikut menang:
- Q16: rilis pertama MANUAL: file bank + persetujuan dua orang (pembuat batch tidak boleh menyetujui). Duitku dibangun nanti tapi mati, dinyalakan per PT (bukan di brief ini).
- Q17: format file bank manual pertama = BCA.
- Q15: biaya transfer ditanggung PT (beban bank); karyawan terima gaji bersih utuh. Simpan biaya per item untuk slice GL (.5), tanpa memotong gaji.
- Q10: bawaan transfer bank bila karyawan punya rekening tercatat, selain itu tunai.
bd memory: `founder-q3-13-nov`, `founder-q10-13-nov`, `founder-q14-18-13-nov`.

## Repo
Worktree baru dari `milestone/m1` (1cbb842d5): `git worktree add .worktrees/disb-648 -b ws/payroll-disbursement-manual milestone/m1`, `pnpm worktree:setup`. Rentang migrasi: **0514-0517**.

## Kartu (`bd show <id>`)
1. `legend-wnkep.1` — test uang gagal-dulu (tulis dulu, `test-writer` subagent).
2. `legend-wnkep.2` — inti: config per badan hukum, batch, state machine item, izin (persetujuan dua orang).
3. `legend-wnkep.4` — kanal manual: ekspor batch yang disetujui ke format BCA + konfirmasi hasil per item.
Tidak termasuk: .3 Duitku, .5 GL, .6/.7 UI (butuh mockup), .8 DOIT.

## Review
Tingkat K (uang + akses + migrasi): satu subagent `architect`, "architect effort xhigh", atas diff gabungan; maks 2 ronde, cek ulang fix dengan reviewer sonnet. Format BCA: catat sumber spesifikasinya; bila tidak pasti, tandai field yang perlu dikonfirmasi bank di laporan.

## Bukti selesai
Test gagal-dulu, test terarah lewat `heavy`, typecheck api lewat `heavy` sekali sebelum lapor, prettier + eslint, `db:generate` kosong, `node --test` tes root registry/izin (`access-i18n`, `legend-g6d`, `data-import-registry`) karena ada izin dan migrasi baru. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Jangan panggil API bank/Duitku sungguhan. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
