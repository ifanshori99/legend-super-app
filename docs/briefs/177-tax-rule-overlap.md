# Brief lanjutan G0fu7: cek tumpang-tindih aturan pajak (legend-de3b)

## Cabang
Cabang baru `ws/tax-rule-overlap` dari ujung `ws/provisioning-race` (bd62055c), worktree `.worktrees/tax-rule-overlap`, `worktree:setup`. Jangan commit lagi di `ws/provisioning-race`. Jangan push, jangan merge.

## Keputusan CTO (cara owner mengganti PBJT-FNB)
Ikuti pola service charge (legend-mdh0, `assertNoServiceChargeOverlap`): `publishTaxRule` menolak aturan aktif kedua yang tumpang-tindih (cakupan outlet/kategori dan periode sama) dengan 409 yang menyebut aturan yang bertabrakan. Owner mengganti default dengan membuat versi baru, lalu menerbitkannya dengan menonaktifkan atau mengakhiri aturan lama dalam satu langkah (atau menonaktifkan dulu, lalu menerbitkan). Tidak ada aturan ganda aktif, jadi `TAX_RULE_AMBIGUOUS` tidak bisa muncul dari jalur owner. Data lama yang sudah ganda: tidak diubah otomatis; tampilkan di laporan/peringatan dan beri jalan memperbaiki.

## Kartu
`ghostex board associate legend-de3b`, `bd update legend-de3b --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `tax.service.ts`, `tenant-config-locks.ts`, validator pajak di shared, UI aturan pajak bila perlu untuk pesan galat, test. Jangan: auto-journal, modul refund, `pos-shift.service.ts`, `pos-order.service.ts` selain pembacaan pajak, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu (default PBJT-FNB + aturan tenant-wide F&B kedua diterbitkan, order gagal `TAX_RULE_AMBIGUOUS`). Race dua publish bersamaan memakai kunci pajak per tenant. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob, laporkan jumlah file jalan. tsc lewat `heavy`, eslint, prettier, kontrak node. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/177b-second-opinion-tax-rule-overlap.md` (tidak di-commit).

## Laporan
Sekali setelah selesai. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
