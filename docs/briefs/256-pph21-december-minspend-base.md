# Brief: engineer (Sonnet) — PPh21 Desember gross_first dan basis min spend

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pph21-dec-minspend` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/pph21-dec-minspend`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Dua kartu, berkas tidak bertumpuk: kerjakan paralel lewat dua `implementer`, satu commit per kartu.

## Tujuan
1. `legend-y2lf` (tingkat K, pajak). PPh21 skema `gross_first`: saldo Jan-Nov (annual(Gs)) dan bagian Desember (annual(P+G*) - annual(P)) beda skala, karyawan bisa membayar lebih dari pajak gross-nya sendiri. Contoh H7 (history-split-reference): gross 60 jt setahun, pajak sendiri 150.000, engine membebani 237.500. Keputusan founder Q52: pakai rumus perbaikan reviewer: bagian Desember `gross_first` = annual(Gs+G*) - annual(Gs), dibatasi (cap) D. Baca komentar `bd show legend-y2lf` dan review legend-mmgd. Tambahkan catatan rilis: rumus wajib dicek konsultan pajak sebelum rilis.
2. `legend-v9fh` (S). Keputusan founder Q53: minimum belanja promo dihitung dari harga sebelum pajak, juga di outlet harga termasuk pajak (inclusive). Lokasi: `qr-order-pricing.ts` (~811), `crm-promo-minspend.ts:16`, web `bill-totals.tsx:135` (tampilan kekurangan min spend harus konsisten dengan API). Exclusive tidak berubah.

## Kartu
Awal tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: engine PPh21 dan test-nya, berkas min spend yang disebut, test promo/QR pricing, `docs/` catatan rilis. Jangan: payroll loan/reimburse (thread lain), migrasi (butuh: berhenti dan lapor), refund.

## Bukti selesai
- Test gagal-dulu: y2lf kasus H7 (beban <= pajak sendiri, sesuai rumus) + kasus tanpa gross-up tidak berubah; v9fh order inclusive yang tepat di ambang (termasuk pajak lolos, sebelum pajak belum) + exclusive tidak berubah.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Bila web tersentuh: typecheck web lewat `heavy`.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir, eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): y2lf tingkat K = satu subagent `architect`; v9fh = satu `reviewer` sonnet. Jalankan bersamaan.
- Tulis brief Codex `docs/briefs/256b-second-opinion-pph21-december.md` untuk y2lf, jangan dijalankan.

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
