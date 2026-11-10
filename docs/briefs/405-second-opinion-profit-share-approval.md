# Brief: second-opinion — profit share: approval versi saham, seed policy, Owner tunggal

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-405 origin/ws/inbox-self-approve`, hapus setelah selesai. Basis review sebelumnya 0033ea1d (377+379). Rentang: `git diff 0033ea1d origin/ws/inbox-self-approve -- <berkas>` (berisi 33im6 54b76963, 3sy9b 360491fa, tm6pp seed policy, owner tunggal be5163bc, UI inbox 22198b5c).

## Berkas
- `apps/api/src/services/profit-share-registry.service.ts`, `profit-share-distribution.service.ts`, `accounting-profit-share.ts`
- `apps/api/src/services/platform-approval.service.ts`, `sole-owner-self-approval.ts`, `accounting-shared.ts`, `core-audit-writer.ts`
- Migrasi: `0239_profit_share_recipient_versions`, `0240_share_version_approval`, `0241_shareholder_version_approval_policy` (di m1 46352cd5), `0270_sole_owner_self_approval`
- `apps/web/src/features/ws01-approvals/logic.ts`

## Invariant
- Perubahan porsi saham dan penerima laporan hanya berlaku setelah disetujui; tidak ada jalur yang melewati approval.
- Pemohon tidak boleh menyetujui sendiri, kecuali tenant punya tepat satu Owner aktif (dihitung di SQL, di bawah kunci role-assignment). Tolak-sendiri selalu ditolak.
- Owner kedua ditambah di tengah proses: persetujuan gagal tertutup.
- Total porsi = 100%; distribusi memakai versi yang berlaku pada periode; versi lama tidak berubah.
- Isolasi tenant dan RLS; audit tiap keputusan, termasuk penanda self-approval.
- Migrasi aman untuk owner non-superuser dengan data lama (trigger deferred, FORCE RLS).

## Effort
xhigh (uang + akses + migrasi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
