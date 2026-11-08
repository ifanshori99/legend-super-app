# Brief: engineer — perbaikan review K ws/edc-framework (5f797fe)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/edc-framework`, cabang `ws/edc-framework`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus (wajib)
1. Tinggi — `apps/api/src/edge/edc/agent.ts:923`, `:972-976`, `:1083-1087`: guardRetry dan cek `blocking` di writeAhead hanya melihat status approved/pending/unknown. Baris "approved late" (status cancelled/failed/declined + `needs_reconciliation=true`, `agent.ts:719-751`) dianggap tidak tertagih → kasir ulang bill dengan key baru → dobel tagih. Fix: ikutkan `needs_reconciliation = true` di ketiga query; tolak dengan kode jelas (mis. `EDC_NEEDS_RECONCILIATION`) sampai void + rekonsiliasi. Test regresi dari skenario `edc-agent.test.ts:999` + ulang bill.
2. Sedang — migration 0063/0064 bentrok dengan main (0063–0067 sudah dipakai): merge `main` ke cabang, renumber via drizzle-kit (jangan edit `_journal.json` tangan), snapshot dari 0067.
3. Rendah — `agent.ts:1027-1043` recoverPending ambil snapshot inFlight sebelum UPDATE; start() ulang bisa ubah baris hidup jadi unknown. Fix: hanya outlet yang baru di-acquire, atau syarat `dispatched_at IS NOT NULL OR created_at < start`.

## Temuan architect
(menyusul)

## Bukti selesai
Test regresi per temuan; gerbang penuh `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`; reviewer subagent konteks segar. Commit lokal di cabang. Laporan: SHA, test, migration lama→baru.
