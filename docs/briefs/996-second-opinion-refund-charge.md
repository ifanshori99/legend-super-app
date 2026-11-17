# 996 Second opinion refund dan charge (uang + migrasi; gerbang rilis area refund/charge)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree (disk sempit): pakai `git diff`/`git show <ref>:<path>` dari folder utama, jangan checkout.
Diff (berurutan, tiap cabang bertumpuk di atas sebelumnya):
(1) `git diff origin/milestone/m1...origin/ghostex/980-refund-sisa-4-kartu` (tip 08187d8b0; migrasi kerja 0540).
(2) `git diff origin/ghostex/980-refund-sisa-4-kartu...origin/ghostex/982-charge-tukar-menu-refund-void-pos` (tip 2ba47d846; migrasi 0550 status voided + 4 CHECK). Bertumpuk di `payment-admin.service.ts` dan `accounting-auto-journal-*`.
(3) `git diff origin/ghostex/982-charge-tukar-menu-refund-void-pos...origin/ghostex/985-charge-refund-manual-void` (tip cda5730e0; migrasi kerja 0565 indeks, 0566 tabel `order_issue_charge_manual_refunds`).
Kartu: legend-m9pf6, legend-9z1r5, legend-17ml, legend-uyw0v (980); legend-nsvu0, legend-s61sg, legend-gt98h (982); legend-mrwtp, legend-v5z4h, legend-9e21l (985). Cabang 994 menyusul; sertakan bila sudah ada tip-nya.
Diterima CTO (jangan dilaporkan): void tunai sisa charge tanpa lantai sendiri (aturan 974); regresi xd2q pada settle manual disengaja; 409 PROVIDER_REFUND_STATUS_UNKNOWN untuk status selain failed.
Cari: refund melebihi total charge atau sisa refund kumulatif (refundSplit, netAllocatedIdrSql di 7 jalur); refund ganda lewat dua jalur (provider, manual, settle); overrideId manual_refund dipakai ulang; void order dengan charge paid yang tidak membalik charge dalam satu transaksi; race void vs refund vs webhook; collect-at-pos timeout yang tetap dihitung paid; lantai expected laci yang bisa dilewati; jurnal akuntansi refund/void tidak seimbang atau dobel; CHECK status voided menolak baris lama; migrasi tidak idempoten atau mematikan RLS/FORCE.
Usul test: skenario refund parsial berurutan, void setelah refund sebagian, dua permintaan refund bersamaan, timeout collect-at-pos.
Hasil: tulis `docs/qa/second-opinion-refund-charge.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain. Lapor hanya saat selesai.
