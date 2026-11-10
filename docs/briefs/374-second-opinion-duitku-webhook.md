# Brief: second-opinion — gateway Duitku: adapter dan webhook

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add .worktrees/so-374 e77bf057` (detached), hapus setelah selesai.
Rentang: `git diff 83074382^ e77bf057 -- <berkas di bawah>`. Diff total 3100 baris; fokus berkas berikut (~1300 baris), baca berkas lain hanya bila perlu jejak panggilan.

## Berkas berisiko
- `apps/api/src/services/payment-duitku-webhook.service.ts`
- `apps/api/src/services/payment-duitku.ts`
- `apps/api/src/services/payment-webhook.service.ts`
- `apps/api/src/routes/payment-webhook.routes.ts`
- (jejak) `payment.service.ts`, `payment-gateway-select.ts`, `platform-payment-gateway.service.ts`

## Invariant
- Tanda tangan callback diverifikasi (constant-time) sebelum apa pun disimpan atau diproses; merchant code dan kunci dari tenant/outlet yang benar, bukan dari body.
- Nominal callback dicocokkan dengan tagihan; kurang/lebih tidak menandai lunas.
- Callback berulang atau balapan tidak membuat pembayaran, jurnal, poin dobel (idempotensi + kunci).
- Status hanya maju (pending -> paid/failed/expired); callback lama tidak menimpa status akhir.
- Isolasi tenant; satu tenant tidak bisa memicu pelunasan tagihan tenant lain.
- Rahasia gateway tidak tercatat di log atau respons.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
