# 486 Accounting / ledger integrity (WS-07, backend)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Worktree sendiri dari `origin/milestone/m1`, cabang `ws/ledger-integrity`. Tingkat K (jurnal akuntansi): review satu subagent architect effort xhigh.

Kartu (selesaikan semua, lalu lapor):
- legend-brq1: trigger DB menolak insert jurnal ke bulan fiskal yang sudah ditutup, plus dimensi `legal_entity` di metrik. legend-v616 duplikat: tutup v616 (`bd close -r "duplikat brq1"`) setelah cek isinya memang sama.
- legend-i5kc: pelepasan dan revaluasi aset dengan tanggal mundur, membalik penyusutan setelah tanggal kejadian.
- legend-uyk2: modul sumber purchasing dan AR wajib memanggil fungsi AP/AR in-transaction. Bila berkasnya bertumpuk dengan cabang WS-06 inventori/resep (`ws/` G8ugp, lihat `git branch -r | grep -i ws-06`), kerjakan bagian yang tidak bertumpuk dan laporkan sisanya.
- legend-68if: sambungkan resolver keanggotaan pemegang saham dan object storage ke route shareholder-documents.

Migrasi: satu file baru untuk trigger brq1, nomor sementara 0310 (merge train menomori ulang). `when` di `_journal.json` unik dan naik.

Uang dan akuntansi: test bukti bahwa jurnal tetap seimbang (debit = kredit), bulan tertutup tidak bisa diubah lewat jalur apa pun, dan pembalikan penyusutan tidak menggandakan nilai aset.

Paralel: Explore 2 (akuntansi period/aset, AP/AR + shareholder route), test-writer gagal-dulu tiap kartu, implementer per kartu (brq1 dan i5kc bisa bersentuhan di service jurnal: berurutan). Test terarah lewat `heavy`. Gate lint per cabang: `pnpm exec eslint` + `prettier --check` berkas berubah, jangan `pnpm --filter @starter/api lint`. Langkah 1: `bd show` + `git log --all --oneline | grep <id>` cek basi. Laporan: commit, test, temuan architect, angka subagent.
