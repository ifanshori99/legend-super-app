# 857 Bug inventori dan akuntansi tingkat S (engineer Codex)

Cabang fix/inv-acct-857 dari milestone/m1. Langkah 0: `git log --all --oneline --grep=<id>` per kartu; sudah ada di cabang lain: catat di laporan, lewati.
Detail kartu: baca `.beads/issues.jsonl` (cari id). Codex tidak menjalankan bd.

- legend-7l2bq: planDeduction menggagalkan seluruh order bila satu lokasi stok milik outlet nonaktif. Lewati lokasi nonaktif seperti snapshot HPP; order tetap jadi.
- legend-mksir: retur supplier gagal ACCOUNT_MAPPING_MISSING bila akun 5106 dipetakan ke akun kustom/non-expense/induk. Terima pemetaan sah; tolak hanya akun induk (non-posting) dengan pesan jelas.
- legend-1get7: laporan pengecualian keuangan: intent DP ikut resolusi receipt-pending.

Test gagal-dulu per kartu. Jurnal tetap seimbang. Tanpa migrasi.
Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Commit + push tanpa force. Lapor sha, test, kartu mana selesai.
