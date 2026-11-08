# Temuan review legend-18qw (untuk engineer, ws/worker-transport)

## Second-opinion (Codex, commit b22d549)
1. Major — `apps/api/src/worker/notification-adapters.ts:636`: `X-Legend-Reference` tidak mengaktifkan deduplikasi Brevo. Email diterima lalu respons hilang -> retry mengirim email kedua (probe mereproduksi). Fix: UUID stabil di `headers.idempotencyKey` (lihat https://developers.brevo.com/docs/heterogenous-versions-batch-emails), respons duplikat dianggap ack, tentukan recovery setelah TTL. Bisa menutup `legend-3a0y`.
2. Major — `apps/api/src/worker/notification-adapters.ts:461`: supervisor banned membuat daftar supervisor nonkosong sehingga fallback owner dilewati; setelah filter banned, penerima kosong padahal owner aktif ada. Fix: filter akun aktif sebelum menentukan fallback. Tambah test.

## Reviewer (Claude)
Kesimpulan reviewer: tidak ada blocker/major. pnpm check hijau. Fix yang diminta CTO (kecil, satu putaran):
3. `notification-delivery.ts:290` `catch {}` menelan error Brevo: log status saja (tanpa body, tanpa email penerima).
4. `core-outbox-gaps.ts:31` UPSERT gap tiap tick: update hanya bila `last_requested_at < now() - interval '1 minute'`.
5. `notification-adapters.ts:663-671`: hanya 400/422 dianggap ditolak permanen, sisanya throw/retry. Tolak sender `.invalid`/`replace_me` saat start.
6. `notification-adapters.ts:718-737`: validasi `BREVO_API_KEY` `/^[\x21-\x7e]+$/` saat start; error hanya menyebut nama key.
7. `notification-adapters.ts:407-413`: `approval.resolved` hanya ke requester yang masih punya assignment aktif di tenant.
8. `notification-adapters.ts:201`: `banExpires` yang sudah lewat dianggap aktif.
9. Catat di `docs/DECISIONS.md`: email Brevo at-least-once (setelah fix #1 dedup lewat idempotencyKey dalam TTL Brevo).

Jadikan bead lanjutan, jangan dikerjakan sekarang:
- `transport.ts:76` event `cloud-sync` tenant-wide di edge selalu dead-letter: pastikan edge tidak memproduksinya.
- `deploy/single-vm/compose.yaml:79-90` worker tanpa healthcheck.
- Sequence per destination tanpa backfill: belum pernah deploy, jadi belum ada data prod; catat di bead sebagai cek wajib sebelum deploy pertama bila ada data staging.

## Bukti selesai
- Test baru untuk #1 (respons hilang lalu retry tidak kirim dua kali / duplikat = ack) dan #2 (supervisor banned -> fallback owner).
- `heavy pnpm check` hijau lewat subagent `test-runner`; subagent `reviewer` cek diff fix.
- Commit lokal di `ws/worker-transport`, pesan merujuk `legend-18qw`. Jangan merge, jangan push.

