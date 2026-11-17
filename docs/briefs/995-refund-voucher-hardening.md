# 995 Refund sistem dan voucher: hardening kecil

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect high (uang, tanpa migrasi) atau reviewer sonnet bila hanya test/alarm.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (tip terbaru). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru bila perlu 0605-0609 (nomor kerja).

Kartu (`bd show <id>`; claim dulu). Sebelum mulai, pastikan kode kartu ada di m1 (`git merge-base --is-ancestor`); yang belum ada: keluarkan dan catat.
- legend-mq7ir (P3): 5 temuan low refund sistem (test dan alarm).
- legend-o8quo (P3): validasi `voucherId` dan `replacementItemId` di `reportOrderIssue`.
- legend-h1da5 (P3), legend-59jya (P3): cakupan reseal kode voucher dan test P3 962.
- legend-8m23m (P3): kode QR yang di-void tidak boleh menahan `windowClosedAt`.

Jangan sentuh: refund manual charge (994, 985, 982), recon provider (980/967), payout (990), supplier/kas (991), akses perangkat (984), payroll, fasilitas.

Jangan sampai rugi: test bukti voucher/refund tidak bisa dipakai melebihi nilai, tidak dobel, tenant lain tidak tersentuh. Bila ragu: blok.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu. Lalu test-runner + architect/reviewer bersamaan. Gate (#9): prettier, eslint, typecheck API (web bila tersentuh), test terarah, `db:generate` kosong. Satu token heavy per thread. Jangan `pnpm check`/`pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal; JANGAN akhiri giliran untuk kabar antara.

Laporan: SHA, kartu, migrasi, test, temuan review, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
