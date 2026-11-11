# 499 HRIS cuti vs payroll tertutup + absensi (WS-D, backend)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Worktree sendiri dari `origin/ws/5nt2z-leave-partial` (sudah masuk batch48g, belum di m1), cabang `ws/hris-leave-guard`. Tingkat K untuk 0c5yg (uang: gaji): architect effort xhigh sekali di akhir.

Kartu (selesaikan semua, lalu lapor):
- legend-0c5yg (P1): cuti (termasuk mundur) tidak boleh mengubah payroll periode yang sudah ditutup. Guard di `hris-leave-request.service.ts` (~1240-1420) dan fungsi flag cuti `0258_leave_clash_backfill.sql:66-127`. Keputusan CTO (membatasi pembayaran): cuti yang jatuh di periode tertutup ditolak 409 kecuali lewat jalur penyesuaian periode berikut yang tercatat (bila jalur itu belum ada: tolak saja). Test bukti tidak ada bayar ganda atau potongan ganda.
- legend-qmte: cuti bersama tidak memotong karyawan yang tetap bekerja.
- legend-j06v: `GET /api/hris/me` + baca kebijakan absensi.
- legend-5nv1: endpoint upload selfie + daftar absensi karyawan sendiri (self-scoped, filter SQL by user).
0c5yg dan qmte bisa bersentuhan di service cuti: berurutan. j06v dan 5nv1 paralel.

Migrasi: perbaikan fungsi 0258 lewat migrasi baru, nomor sementara 0320 (merge train menomori ulang), `when` unik naik.

Paralel: Explore 2, test-writer gagal-dulu tiap kartu, implementer per kartu, reviewer sonnet untuk j06v+5nv1. Test terarah lewat `heavy`. Gate lint: `pnpm exec eslint` + `prettier --check` berkas berubah, tanpa array zsh. Langkah 1: `bd show` + `git log --all --oneline | grep <id>` cek basi. Push cabang. Laporan: commit, test, temuan architect, angka subagent.
