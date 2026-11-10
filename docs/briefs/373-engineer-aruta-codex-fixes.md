# Brief: engineer — perbaikan temuan Codex kasir aktif POS (legend-5u03q)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti.

## Worktree
`.worktrees/aruta-pos-pin` (cabang aruta, HEAD f609a047). Lanjutkan di sana, commit di cabang yang sama.

## Tujuan
Tutup 4 temuan second-opinion Codex (brief 371). Tiap temuan: test gagal-dulu, lalu fix.
1. P1 `apps/web/src/lib/api/acting-staff.ts:69`: token kedaluwarsa dihapus tanpa memblokir request, mutasi berikut jalan tanpa header memakai identitas dan izin pemilik sesi. Fix: request mutasi tanpa token valid ditahan, minta PIN ulang, baru diteruskan.
2. P1 `apps/api/src/services/pos-acting-staff.service.ts:123`: verifikasi PIN dan insert token di transaksi terpisah; reset PIN di antaranya membuat token dari PIN lama lolos pencabutan. Fix: satu transaksi, kunci baris PIN (FOR UPDATE), cocokkan generasi/versi PIN saat insert.
3. P1 `apps/api/src/edge/access-applier.ts:302`: adopsi reset PIN edge->cloud tidak mencabut token. Fix: panggil `revokeActingStaffForStaff` dalam transaksi adopsi material PIN.
4. P2 `apps/api/src/routes/device-pin.routes.ts:148`: GET override tidak membatasi outlet token; staf multi-outlet baca dan selesaikan pending override outlet lain. Fix: teruskan outlet token, filter query sebelum `settlePending`.

## Cakupan
Hanya berkas di atas, test-nya, dan helper langsung. Tanpa migrasi baru; bila wajib, pakai rentang 0248, jangan menomori ulang.

## Bukti
- Test baru untuk keempat skenario gagal sebelum fix, lulus sesudah.
- `heavy` typecheck api + web, test file terkait. Batas Retro 11: 2x gagal typecheck, baca log.
- Satu subagent architect (tingkat K, akses) mereview diff fix.

## Laporan
Commit SHA, test yang ditambah, hasil typecheck/test, temuan architect dan penanganannya.
