# 503 Second-opinion Codex: area ledger (ws/ledger-guards)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). READ-ONLY: jangan edit, jangan commit.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Diff: `git diff origin/ws/ledger-integrity...origin/ws/ledger-guards` (abaikan snapshot drizzle JSON). Konteks temuan: docs/briefs/497*, docs/briefs/500*.

Fokus (uang, tingkat K):
- Fungsi `app.record_depreciation_reversal` dan trigger 0314: bisakah depresiasi dibalik dua kali, atau jurnal dibalik tanpa cermin akun?
- Trigger `fiscal_periods` + `legal_entities.ledger_version`: celah tulis ke periode tertutup (race REPEATABLE READ, jalur INSERT/UPDATE lain, SECURITY DEFINER, RLS).
- Revaluasi mundur + repost bulan terdampak: posting ganda, selisih pembulatan, tolak 409 yang bocor sebagian tulis.
- Akses dokumen pemegang saham per versi alokasi berlaku.
- Grant `legend_app` (DELETE/TRUNCATE/INSERT dicabut) konsisten di semua migrasi.

Laporan: daftar temuan P0-P3 dengan file:baris, skenario gagal konkret, dan usulan fix. Tanpa temuan: tulis itu jelas.
