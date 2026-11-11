# 497 Second opinion Codex: ledger integrity WS-07 (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit. Effort xhigh (uang + migrasi).

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan: `git diff origin/milestone/m1...origin/ws/ledger-integrity` (e916b037: legend-brq1 trigger 0310 tolak jurnal ke bulan fiskal tertutup + dimensi `legal_entity` metrik; legend-i5kc 0311 pembalikan depresiasi append-only, jurnal koreksi; legend-68if route shareholder-documents ke storage runtime).
Fokus: jalur apa pun yang masih bisa menulis/mengubah jurnal di bulan tertutup (UPDATE, DELETE, COPY, fungsi SECURITY DEFINER, balapan dengan close), jurnal seimbang, nilai buku aset tidak ganda, idempotensi run depresiasi setelah koreksi, migrasi aman untuk data ada, `when` journal unik naik, kebocoran antar tenant/legal entity di metrik, akses dokumen pemegang saham.

Sudah diketahui (jangan dilaporkan ulang): legend-k048r (pembalikan manual jurnal depresiasi), legend-lt0v4 (akses dokumen dari versi alokasi lama + UPDATE fiscal_periods.status), jurnal koreksi memakai pemetaan akun hari ini, scanner production menolak semua dokumen (503), storage key tanpa awalan tenant, legend-uyk2 diblokir.

Laporan: temuan P0..P3, file:line, skenario gagal konkret, usul perbaikan. Maks 12, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
