# 1140 Fix SO kas ronde 8 (tingkat K uang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore, test-writer, implementer per temuan, berkas terpisah).
Lanjutkan cabang `ghostex/cek-kas-1102-pinjaman-reimburse-supplier` (head eab61aa7a) di worktree dari Ghostex. Push tanpa `--force`. Tanpa migrasi (bila wajib: berhenti dan lapor dulu, nomor dari CTO).
Laporan SO: `docs/qa/second-opinion-kas-ronde8-1138.md` (folder utama).

Keputusan CTO (membatasi pembayaran):
1. P1-1 `accounting-petty-cash.service.ts:746`, `accounting-journal.service.ts:1122,1131`: reversal jurnal kasbon/reimburse yang sumbernya masih `disbursed` ditolak 409 berdasarkan identitas sumber dan akun snapshot/historis jurnal (`posting_account_snapshot`), bukan mapping saat ini. Hitungan cadangan memperhitungkan reversal atas jurnal asli; bila ragu, cadangan tetap tertahan.
2. P2-1 `tenant-config-finance.ts:507`: impor konfigurasi memakai protokol kunci yang sama dengan endpoint mapping (kunci chart sebelum membaca dan memvalidasi gabungan), urutan kunci tenant/chart selaras supaya tidak menambah deadlock.
3. P2-2 `scripts/preflight/1118-shared-cash-mapping.sql:89` dan helper cadangan `accounting-petty-cash.service.ts:773,798`: nominal NULL/hilang/tidak positif = baris penghalang (gerbang) dan cadangan tertahan (helper), dicek sebelum penyaringan neto.

Bukti: test gagal-dulu sesuai usul test di laporan SO (rantai HTTP cairkan, consume, remap A->B, reverse, remap B->A, cairkan kedua; dua koneksi dengan barrier untuk impor vs mapping; fixture NULL dan key hilang untuk gerbang). Regresi terarah kas/kasbon/reimburse/payout lewat `heavy`. Typecheck API sekali lewat `heavy`. Prettier/eslint. `db:generate` kosong. `architect` xhigh sekali.
Laporan: head SHA, temuan tertutup, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
