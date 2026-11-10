# Brief 144: second-opinion — beberapa dana tak teralokasi di satu tagihan (legend-knev)

> Catatan CTO 9 Nov 20:50: `ws/multi-fund` sudah digabung ke `milestone/m1` (cc6f057e, tip cabang ca32e3ea) lalu dihapus. Pakai `git diff 446d05b3 ca32e3ea` dari folder utama `/Users/ifanshori99/Projects/legend super app/legend` (read-only, jangan checkout). Cek juga perubahan sesudahnya di m1 pada file yang sama (`git log ca32e3ea..milestone/m1 -- <file>`). Catatan: Codex 134 baru menemukan legend-2ol8g, legend-3usn8, legend-kl46s di area refund; jangan laporkan ulang, fokus pada multi-fund.

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/multi-fund`, cabang `ws/multi-fund`.
Rentang diff: `git diff 446d05b3 ws/multi-fund` (base `ws/refund-escalation` 446d05b3). Satu run: diff non-test sekitar 150 baris, di bawah batas 800.
Tanpa migrasi (`pnpm db:generate` kosong).

## Berkas berisiko
- `apps/api/src/services/payment-admin-funds.service.ts` (model per-dana, `billFundsState`, urutan kunci resolve)
- `apps/api/src/services/payment-refund.service.ts` (pemetaan bukti otomatis saat payout ~1235-1300, `mapFundEvidence` ~2106)
- `apps/api/src/services/payment.service.ts` (`recordUnsettledGatewayFunds` ~1000 kini menyimpan `evidenceId`)
- `packages/shared/src/payment/admin.ts` (refine `unallocatedFundViewSchema`)
- Test: `apps/api/src/test/payment-admin-multi-fund.test.ts`

## Invariant
- PAY-04: uang di atas tagihan ditahan sampai ada refund atau kredit yang disetujui.
- Satu tagihan (`payment_links`) boleh punya beberapa dana, satu per bukti provider (`evidence_id` unik).
- Jumlah semua dana satu tagihan = total bukti diterima − `payment_links.paid_idr` (bagian teralokasi). Tidak sama: 409, fail-closed.
- Satu dana tidak pernah melebihi bukti yang membawanya; refund tidak pernah meminta provider lebih dari transaksi yang dibalik.
- Resolve satu dana membuat satu refund pending sebesar dana itu saja. Refund hidup (status selain `failed`) semua dana tagihan + dana ini ≤ kelebihan tagihan.
- Urutan kunci resolve: tagihan → intent → dana → refund (sama dengan settlement: tagihan sebelum intent). Payout dan `mapFundEvidence`: intent → dana → refund, tidak mengunci tagihan.
- Isolasi tenant di setiap query dan subquery.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
