# 1223 PTKP mengikuti status awal tahun pajak (SO 1221 A P2-1) — engineer Opus

Temuan: `docs/qa/second-opinion-1221-a.md` P2-1. Base `int/batch101`. Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1223" -b ws/1223-ptkp-tax-year int/batch101`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Aturan umum: `docs/briefs/1217-1220-fix-so1216.md` (migrasi sesudah 0514, FK inline, db:generate kosong, check-migration-redefinitions).

Aturan (PMK 168/2023): PTKP setahun = status per 1 Januari tahun pajak, atau saat mulai bekerja bila masuk di tengah tahun. Perubahan status di tengah tahun berlaku tahun berikutnya. Kategori TER bulanan mengikuti PTKP yang sama.

Desain sesederhana yang benar: simpan riwayat PTKP karyawan dengan tanggal berlaku (tulis saat HR mengubah status, backfill status sekarang untuk karyawan yang ada), lalu simulate (`payroll-run-simulate.service.ts:557`, `:880`) dan A1 (`payroll-coretax-a1.service.ts:315`) memakai status per awal tahun pajak/tanggal masuk. Tanpa riwayat sebelum 1 Januari -> pakai baris tertua yang ada. Slip yang sudah dikunci tidak dihitung ulang.

Test fail-first: TK/0 menikah Juli -> K/0; run Juli-Desember tetap PTKP 54 jt + TER A; tahun berikut K/0. Karyawan masuk Maret dengan K/1 -> K/1. Budget 50 tool call, commit di 40. Lapor SHA, merah->hijau, keputusan, yang belum.
