# 518 Second-opinion Codex: sarapan wajib lunas (ws/breakfast-pay)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). READ-ONLY. Repo: /Users/ifanshori99/Projects/legend super app/legend. Diff: `git diff origin/ws/ui-mixed-q36...origin/ws/breakfast-pay` (abaikan snapshot drizzle JSON dan screenshot).
Fokus (uang, tingkat K, invariant founder: pesanan sarapan belum lunas tidak pernah masuk dapur; outlet tidak rugi; tidak ada yang dibayar lebih): migrasi 0321-0322 (trigger kitchen_tickets/kitchen_ticket_items, SECURITY DEFINER, RLS), jalur kirim dapur (retry, edge sync, captain, resend, sweep), bayar ganda, uang telat setelah batal/ends_at, refund termasuk PB1 tidak melebihi bayar, kunci idempotency refund.
Laporan: temuan P0-P3 dengan file:baris, skenario gagal konkret, usulan fix. Tanpa temuan: tulis jelas.
