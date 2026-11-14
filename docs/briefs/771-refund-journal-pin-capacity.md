# 771 Refund jurnal: kapasitas pin untuk recovery tanpa source dan jurnal payload-only (legend-zwaro)
Peran: engineer (Claude Sonnet high; keputusan sudah diambil CTO). Area uang: review architect effort xhigh. Base: ghostex/refund-pin-earlierintentwant-per-key (0df6d5e09). Cabang: fix/refund-journal-pin-capacity. Tanpa migrasi.
Temuan second opinion (baca docs/qa/second-opinion-refund-journals.md di base worktree utama, atau di commit CTO):
1. accounting-auto-journal-amounts.ts:1163,1204: recovery tanpa source mengabaikan kewajiban refund sebelumnya. Refund Rp30.000 lalu recovery Rp20.000 sama-sama dijurnal terhadap pin Rp40.000.
2. :1027,1141,1202: jurnal payload-only sebelumnya tidak mengurangi kapasitas pin. Dua refund Rp30.000 + Rp20.000 lolos terhadap pin Rp40.000.
Keputusan: keduanya harus mengurangi kapasitas pin; yang melebihi di-park (aturan membatasi). Test merah dulu untuk kedua skenario (pakai angka di atas), lalu perbaiki. ARR-1..19b dan test penjaga 409 tetap hijau. Jurnal tetap seimbang.
Aturan umum: baca ~/.agents/team/roles/engineer.md dan "Paralel dulu" di ~/.agents/team/TEAM.md. Test terarah + `heavy pnpm --filter @starter/api typecheck` sekali; jangan pnpm check. Pra-gate AGENTS.md. Commit, push cabang tanpa force, jangan merge. Lapor angka subagent.
