# Brief: engineer — perbaikan temuan Codex 418 (area PIN), kartu legend-fjwxo

## Peran
Baca `~/.agents/team/roles/engineer.md` dan "Paralel dulu" di `~/.agents/team/TEAM.md`. Giliran pertama: Explore + test-writer + implementer per berkas (hris-employee / staff-pin-proof / pos-order-support / payslip-pin), sekaligus.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/fix-418`, cabang `fix/codex-418-pin` dari `origin/ws/merge-batch48c` (berisi hris-pii-pin dengan `payslipPinPepper` per tenant). Lalu merge `origin/ws/payslip-pin-ui` dan `origin/ws/qih2m-payslip-otp` ke cabang ini; pada konflik pepper, pakai `payslipPinPepper` (pepper khusus cloud, tidak pernah dikirim ke edge). `pnpm worktree:setup`.

## Temuan (keputusan CTO: betulkan semua kecuali 6)
1. P1 `apps/api/src/services/hris-employee.service.ts:442` — replay idempotensi membedakan PIN cocok sebelum menghitung percobaan; tebakan tanpa batas, termasuk saat terkunci. Hilangkan oracle: replay hanya mengembalikan hasil tersimpan, dan setiap verifikasi menghitung percobaan secara atomik.
2. P1 `apps/api/src/services/staff-pin-proof.service.ts:661` — window per-user tidak dihitung bila device terverifikasi ada; terapkan window per-user DAN per-device bersamaan (termasuk konversi open bill).
3. P1 `apps/api/src/services/pos-order-support.ts:728` — approval override PIN tidak terikat device; simpan id device terverifikasi saat dibuat, cocokkan saat replay dan konsumsi.
4. P1 `apps/api/src/services/payslip-pin.service.ts:233` — pepper staf (dikirim ke edge) di cabang UI/qih2m; pastikan setelah merge semua jalur PIN slip memakai `payslipPinPepper`; test yang membuktikan pepper staf tidak bisa memverifikasi PIN slip.
5. P2 `payslip-pin.service.ts:776` — kedaluwarsa kode dicek dengan waktu sebelum lock; ambil waktu setelah lock.
6. P2 `apps/api/src/app.ts:181` provider WhatsApp produksi — BUKAN tugas ini (kartu legend-w8dfz).

## Bukti selesai
Test gagal-dulu per temuan 1–5 (termasuk request paralel dan dua device), lalu lulus. tsc + eslint + test area (payslip-pin*, staff-pin*, pos-order override, hris-employee) via `heavy`. Satu subagent architect effort xhigh (akses) atas diff; temuan nyata dibetulkan.

## Kartu
`ghostex board associate legend-fjwxo`, `bd update legend-fjwxo --status in_progress`. Selesai: `--status review` + `bd comment`. Cabang ini menggantikan payslip-pin-ui + qih2m di batch48d (merge train ambil cabang ini).

## Laporan
Commit, push. Hasil, bukti test, subagent dan puncak, risiko.
