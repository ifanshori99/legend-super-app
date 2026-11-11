# Sub-brief legend-ti19m: urutan filing monoton di bawah lock intent

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ti19m-filing-order`, cabang `ws/ti19m-filing-order` (dari ws/pti5r-promo-refund 326bfbfa). Konteks: `docs/briefs/sub-pbwzq-codex422.md`, `docs/briefs/sub-fwe4l-swap-cap.md`.

## Temuan (Codex 423 P1)

`apps/api/src/services/order-recovery-refund.ts` ~835-875 (`findRecoveryRefundReplay`): pendahulu = issue dengan refund pertama paling baru menurut `payment_refunds.created_at`. `created_at` = jam fakta dari `lockIntentsForFact` (`payment-refund-fact-time.ts`), yang hanya `>= max(completed_at)`, jadi tidak monoton untuk refund yang belum selesai: jam host mundur atau timestamp seri -> A gagal final, B diajukan lalu `rejected`, C memilih A (bukan B) dan membuka refund lagi (uang `rejected` lolos).

## Perbaikan

Urutan filing monoton yang ditetapkan saat filing di bawah lock intent (filing consumer dan hook kegagalan sama-sama mengunci intent lebih dulu). Pilihan utama tanpa migrasi: nomor urut filing per order (`filingSeq` = max seq filing recovery order itu + 1), dihitung di dalam lock intent, disimpan di respons `payment_admin_idempotency` (key `order-recovery-refund:<issueId>`) dan audit `refund_requested`; pendahulu = seq tertinggi. Data lama tanpa seq: urut di bawah semua yang ber-seq, lalu fallback ke urutan lama (created_at, id) — jelaskan di komentar. Migrasi hanya bila terpaksa (range 0271, nama > 1794450000000) — laporkan dulu. Refile (approval_expired) tidak mengubah seq issue.

## Test gagal-dulu (file baru `apps/api/src/test/order-recovery-refund-filing-order.test.ts`)

- Clock skew: A gagal final (provider_declined); B diajukan dengan `created_at` refund LEBIH TUA dari A (paksa lewat SQL atau jam fakta mundur) lalu `rejected`; C dilaporkan -> C berakhir nothing_left (pendahulu B), bukan replay A.
- Timestamp seri: A dan B `created_at` sama persis, B diajukan setelah A; id B < id A bila bisa -> C memilih B.
- Arah sebaliknya: B gagal final non-rejected setelah A rejected -> C replay B.
- Regresi: rantai A->B->C, T3 urutan pbwzq tetap lulus.
  Pola seed/helper: `apps/api/src/test/order-recovery-refund-codex422.test.ts`.

## Aturan

- implementer: hanya `order-recovery-refund.ts` (+ `payment-refund-fact-time.ts` bila perlu). test-writer: hanya file test baru.
- Jangan jalankan `pnpm test` (agent utama yang menjalankan). Typecheck `heavy pnpm --filter @starter/api typecheck`, prettier bersih. Jangan commit. Jangan baca `.env*`.
