# Brief: second-opinion — Gateway Duitku, ulang atas perbaikan

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-406 origin/ws/s5jup-duitku`, hapus setelah selesai. Review pertama: brief 374 (4 temuan). Rentang perbaikan: `git log --oneline origin/milestone/m1..origin/ws/s5jup-duitku` (duitku-codex-fix 1b301b15 + s5jup 008cbd93); baca juga temuan lama di `docs/briefs/374-second-opinion-duitku-webhook.md` dan `376-engineer-duitku-codex-fixes.md`.

## Berkas
`payment-duitku-webhook.service.ts`, `payment-duitku.ts`, `platform-payment-gateway.service.ts`, `payment-gateway-select.ts`, `payment-routing.service.ts`, poller status Duitku.

## Invariant
- Webhook terverifikasi tanda tangan; replay/duplikat tidak membayar dobel; jumlah dan reference cocok dengan intent, mismatch gagal dan diberi peringatan.
- paidAt = min(now, receivedAt) hanya untuk pending; status final tidak mundur.
- Reference pending dicoba ulang; poller dan webhook balapan tidak merusak status.
- Kredensial per tenant tidak bocor antar tenant; tidak ada rahasia di log.
- Keempat temuan 374 benar-benar tertutup.

## Effort
xhigh (uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran; plus status tiap temuan 374. Tidak ada temuan baru: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
