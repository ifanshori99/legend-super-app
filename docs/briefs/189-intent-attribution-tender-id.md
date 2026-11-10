# Brief: engineer — atribusi intent POS pakai tenderId/paymentIntentId per baris refund (legend-9z1vm)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/intent-attribution-tender` dari ujung `milestone/m1` terbaru, sesudah `ws/pos-refund-promo` (batch17) dan `ws/refund-followups-2` masuk m1. Cek dulu: `git log milestone/m1 --oneline | grep -iE 'refund-promo|refund-followups-2'`; bila belum ada, lapor dan berhenti. Worktree `.worktrees/intent-attribution-tender`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-9z1vm` (tingkat K: uang). `pos-intent-attribution.ts` kini fail closed (ELSE 0, sekitar :95-101) untuk refund sebagian pada pesanan dengan dua intent QRIS. Pakai `pos_order_refunds.lines[].paymentIntentId` / `tenderId` (ditulis sejak ws/pos-refund-promo) supaya refund diatribusikan ke intent yang tepat. Baris lama tanpa id tetap memakai aturan per metode (arah aman tetap). Kartu yang sama masalahnya ikut ditutup di sini: `legend-45bs9` (dua intent QRIS + refund sebagian, keduanya tertahan) dan `legend-8v2yl` (baris refund mencatat tender/intent; cek dulu apakah ws/pos-refund-promo sudah memenuhinya). Patch WIP lama (dibuat di atas d2f8c072, desain `lines[i].tenders=[{tenderId,paymentIntentId,amountIdr}]` tanpa migrasi): `docs/briefs/185-task4-wip-8v2yl-45bs9.patch` di folder utama. Pakai sebagai bahan, bukan untuk di-apply buta. Detail: `bd show legend-9z1vm`, `bd show legend-45bs9`, `bd show legend-8v2yl`.

## Kartu
`legend-9z1vm`, `legend-45bs9`, `legend-8v2yl`. Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `pos-intent-attribution.ts` dan pembacanya, test terkait. Jangan: skema/migrasi, `pos-shift.service.ts`, `pos-day.service.ts`, auto-journal, payroll, open bill, edge (`staff_pin*`, `receipt_sequences`), `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: refund sebagian pada pesanan dua intent QRIS dengan id baris diatribusikan ke intent yang benar; baris lama tanpa id tetap aturan per metode; id yang tidak cocok dengan pesanan ditolak (fail closed). `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/189b-second-opinion-intent-attribution.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
