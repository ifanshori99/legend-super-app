# Sub-brief 100: approval expiry race (tingkat K)

Worktree: `.worktrees/fix-journals-expiry`, cabang `ws/fix-journals-expiry`. Semua path di bawah relatif ke `apps/api/src/`.
Jangan commit; agent yang menggabungkan. Jangan `pkill`/`killall` proses test.

## Bug
Module settle membaca `getApprovalChainOutcome` (tanpa lock), lalu bila `pending` dan deadline lewat, menimpa lokal `outcome = "expired"` dan menolak row modulnya. Inbox `decideApprovalRequest` (`services/platform-approval.service.ts` ~987) mengunci chain head (`lockChain`, level-1 row FOR UPDATE) dan bisa mulai sebelum deadline tapi belum commit. Settle tidak melihat tulisan yang belum commit → row modul `rejected`, lalu inbox commit `approved`, consumer `approval.resolved` melihat row sudah tidak pending → posting/efek hilang.

Titik racy:
- `services/accounting-journal-manual.service.ts` `settleRow` ~695-720
- `services/accounting-journal-recurring.service.ts` `settleLocked` ~398-430
- `services/staff-override.service.ts` ~620-650 (pola sama, POS override)
- `services/inventory-count.service.ts` ~1423-1431: memanggil `cancelApprovalRequest` tapi mengabaikan nilai kembalinya dan selalu set `outcome = "expired"`; bila decide menang (cancel mengembalikan `approved`), count tetap jadi expired.

## Fix (kontrak)
Potongan A menambah di `services/platform-approval.service.ts`, tepat setelah `getApprovalChainOutcome`:

```ts
/**
 * The chain's outcome for a source module that settles synchronously, with
 * the deadline applied atomically: locks the chain head (the lock every
 * decide takes), re-reads, and when the open level is still pending past its
 * deadline expires it here (conditional on status 'pending'), emitting
 * approval.resolved (expired, system) + audit approval.expired like the sweep.
 * An inbox decision already in flight commits first and wins.
 */
export async function resolveApprovalChainOutcome(
  tx: Tx,
  context: ScopedTenantContext,
  input: { readonly chainId: string; readonly sourceModule: string; readonly now: Date },
): Promise<ApprovalOutcome>
```
Logika: `lockChain` → `chainRows` → sourceModule cek (notFound seperti `getApprovalChainOutcome`) → tidak ada row `pending`: `chainOutcome(rows)` → pending dan `deadlineAt > now`: `"pending"` → else `UPDATE ... SET status='expired', updatedAt=now WHERE id=open.id AND status='pending' RETURNING`; kosong (sweep menang): `chainOutcome(await chainRows(...))`; berhasil: `emitResolved(..., "expired", {type:"system"}, now)` + `recordAudit` bentuk sama dengan sweep `expireDueApprovalRequests`; return `"expired"`. Boleh ekstrak helper bersama dengan sweep untuk emit+audit.

Callers (potongan B dan C): ganti `getApprovalChainOutcome` + override deadline lokal dengan satu panggilan `resolveApprovalChainOutcome(tx, context, { chainId, sourceModule, now })`. Baca row level terakhir (`decidedBy`, dst.) SETELAH panggilan itu supaya `decidedBy` segar bila decide baru saja commit. Perilaku lain tidak berubah (alasan reject `approval expired` dsb. tetap).
Inventory count: tetap `cancelApprovalRequest` (komentar: supaya resubmit tidak terblokir) tetapi pakai nilai kembalinya: `cancelled` → `expired`; selain itu pakai outcome yang dikembalikan, dan baca ulang level terakhir bila berubah.

## Potongan (berkas tidak bertumpuk)
- A (implementer): `services/platform-approval.service.ts` + test baru `test/platform-approval-resolve-outcome.test.ts` (pending dalam deadline, expired lewat deadline + event+audit sekali, sweep sudah expired → tidak emit dua kali, chain sudah approved → approved, sourceModule salah → notFound).
- B (implementer): `services/accounting-journal-manual.service.ts`, `services/accounting-journal-recurring.service.ts`.
- C (implementer): `services/staff-override.service.ts`, `services/inventory-count.service.ts`.
- D (test-writer): `test/accounting-journal-expiry-race.test.ts` (manual + recurring).
- E (test-writer): `test/approval-expiry-race-modules.test.ts` (POS override + inventory count).

## Pola test race (D, E)
Deterministik, tanpa sleep: client raw dari pool owner (`STARTER_TEST_DATABASE_URL`, lihat `test/crm-promo-locks.test.ts` ~45 dan `test/pos-order-deposit-lock.test.ts` ~242-290) membuka `BEGIN`, `SELECT ... FROM approval_requests WHERE id=<chainId> FOR UPDATE`, lalu `UPDATE` level terakhir ke `approved` dengan `decided_by`=approver sah (meniru decide inbox yang belum commit). Jalankan settle modul dengan `now` lewat deadline secara paralel; buktikan settle menunggu (mis. belum selesai setelah lock dipegang), lalu `COMMIT` → harapkan row modul approved/posted (jurnal: posted, ada ledger entry). Kasus kedua: settle lewat deadline tanpa decide → row modul rejected/expired, approval row `expired`, lalu `decideApprovalRequest` → `APPROVAL_REQUEST_EXPIRED`. Pakai helper setup yang sudah ada di `test/accounting-journal-manual-settle.test.ts` dan `test/accounting-journal-recurring-fixes.test.ts`.
Run satu file dari root worktree: `LEGEND_TEST_FILES="apps/api/src/test/<file>" pnpm test` (cek `scripts/test.mjs`). Test D/E memakai `resolveApprovalChainOutcome` hanya lewat service modul, jadi bisa ditulis sebelum B/C selesai; kasus pertama diharapkan GAGAL pada kode lama (reproduksi).

## Bukti selesai
File test masing-masing lulus; `pnpm --filter api exec tsc --noEmit` tidak dijalankan subagent (gate oleh agent lewat `heavy`). Laporan: berkas berubah, hasil run test terarah.
