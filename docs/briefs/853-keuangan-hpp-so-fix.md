# 853 Perbaikan second opinion keuangan dan HPP (engineer Sonnet)

Temuan: docs/qa/second-opinion-keuangan-hpp-15nov.md (2 P2). Keputusan sudah diambil CTO: perbaiki sesuai baris "Perbaikan".

- Temuan 1: cabang fix/hpp-return-rounding-853 dari ws/hpp-stock-followups (f6315f99f). Test gagal-dulu: terima 3 @1.000,3333, retur 1+1+1, GL persediaan 0, 5106 tidak terkredit selisih pembulatan, jurnal seimbang, utang supplier tidak berubah.
- Temuan 2: cabang fix/finance-exc-tender-intent-853 dari ghostex/845-finance-view-access (43e9824fa), worktree terpisah (git worktree add). Test gagal-dulu: order POS dengan tender ber-intent menampilkan intentId dan outboxState yang benar; beberapa intent per order.
- Paralel: test-writer per temuan, implementer per temuan.
- Tanpa migrasi.
- Review: satu subagent architect effort xhigh (uang) untuk gabungan.
- Pra-gate AGENTS.md. Commit + push tanpa force kedua cabang. Lapor sha tiap cabang dan angka subagent.
