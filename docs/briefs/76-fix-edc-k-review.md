# Brief: engineer — perbaikan review K ws/edc-framework (5f797fe)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/edc-framework`, cabang `ws/edc-framework`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus (wajib)
1. Tinggi — `apps/api/src/edge/edc/agent.ts:923`, `:972-976`, `:1083-1087`: guardRetry dan cek `blocking` di writeAhead hanya melihat status approved/pending/unknown. Baris "approved late" (status cancelled/failed/declined + `needs_reconciliation=true`, `agent.ts:719-751`) dianggap tidak tertagih → kasir ulang bill dengan key baru → dobel tagih. Fix: ikutkan `needs_reconciliation = true` di ketiga query; tolak dengan kode jelas (mis. `EDC_NEEDS_RECONCILIATION`) sampai void + rekonsiliasi. Test regresi dari skenario `edc-agent.test.ts:999` + ulang bill.
2. Sedang — migration 0063/0064 bentrok dengan main (0063–0067 sudah dipakai): merge `main` ke cabang, renumber via drizzle-kit (jangan edit `_journal.json` tangan), snapshot dari 0067.
3. Rendah — `agent.ts:1027-1043` recoverPending ambil snapshot inFlight sebelum UPDATE; start() ulang bisa ubah baris hidup jadi unknown. Fix: hanya outlet yang baru di-acquire, atau syarat `dispatched_at IS NOT NULL OR created_at < start`.

## Temuan architect (urutan: 1, 2, 3, 4, lalu 5–7; test hitung `chargedCount` tetap 1)
1. Sedang — sama dengan temuan 1 reviewer, diperluas: tolak `EDC_STATUS_UNKNOWN` bila ada baris untuk referensi itu yang masih di `inFlight` apa pun statusnya, dan bila ada baris `needs_reconciliation` (`guardRetry` + cek `blocking` di `writeAhead`, `agent.ts:1083-1087, 972-976, 923-929`).
2. Sedang — `agent.ts:279-284`: inquiry `not_found` dari `by_trace` dipercaya tanpa batas umur, padahal kontrak `packages/shared/src/edc/index.ts:238` bilang `by_trace` hanya batch saat ini → setelah settlement baris approved jadi `failed`, retry lolos, dobel tagih. Fix: percaya `not_found` hanya dalam jendela maks sejak `dispatched_at`; di luar itu tetap `unknown` + `needs_reconciliation`.
3. Sedang — `agent.ts:1203-1215`: `cancel` tidak lewat `withTerminalLock` dan tak cek `stuck`; `:292-294` terima `trace` null → jawaban transaksi lain tercatat untuk baris ini. Fix: cancel lewat antrean kecuali baris di `inFlight`; tolak bila terminal `stuck`.
4. Sedang — `agent.ts:29-30`: tidak ada outbox `edc_transaction.*` → EDC-05 (sinkron setelah pulih) tidak terpenuhi, EDC-06 tak bisa jalan. Fix: tulis event ke outbox dalam transaksi yang sama.
5. Rendah — `registry.ts:39-46`: `simulator: true` tak dijaga di production. Fix: lempar error di production.
6. Rendah — sama dengan temuan 3 reviewer (`recoverPending`).
7. Rendah — `0063_edc_transactions.sql`: kolom `type` (sale/void/refund), `mode` (ecr/standalone), `payment_intent_id` dari PRD §6 belum ada; `EdcProvider` tanpa `void`. Fix: tambah kolom sekarang selagi tabel kosong (sekalian generate ulang migration, lihat "Catatan merge milestone" di PROGRESS).

## Bukti selesai
Test regresi per temuan; gerbang penuh `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`; reviewer subagent konteks segar. Commit lokal di cabang. Laporan: SHA, test, migration lama→baru.
