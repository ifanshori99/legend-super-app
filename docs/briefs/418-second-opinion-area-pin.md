# Brief: second-opinion — area PIN (PIN staf override POS vfj7z + PIN slip gaji)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-418 origin/ws/payslip-pin-ui`, hapus setelah selesai. Bandingkan juga `origin/ws/qih2m-payslip-otp` dan `origin/ws/merge-batch48c`.
Rentang:
- vfj7z: `git show be9ce98d` (slot device + window per user di jalur override POS dan konversi open bill; sudah di m1).
- PIN slip gaji: `git log --oneline origin/milestone/m1..origin/ws/payslip-pin-ui` dan `..origin/ws/qih2m-payslip-otp` (payslip_pins, `payslipPinPepper` per tenant, remainingAttempts/lockedUntil, reset HR, kode WhatsApp).

## Invariant
- PIN dibuat karyawan sendiri; HR hanya reset, tidak pernah melihat/mengatur PIN.
- Hash + pepper; pepper tidak bocor; tidak ada PIN/kode di log, URL, atau audit.
- Batas percobaan dan kunci atomik saat request paralel; `remainingAttempts` tidak bisa dipakai menebak tanpa batas.
- Kode WhatsApp: sekali pakai, kedaluwarsa, rate limit, tidak bisa dipakai lintas karyawan/tenant.
- Nominal slip tidak keluar sebelum PIN benar; isolasi tenant + RLS.
- Override POS: device terverifikasi dan jendela per user, tidak bisa dipakai ulang dari device lain.

## Effort
xhigh (akses + data pribadi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
