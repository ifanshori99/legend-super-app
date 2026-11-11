# 538-G2b: perbaikan temuan architect payroll

Scope: cabang `ws/payroll-engine`, worktree `.worktrees/payroll-engine`. Pelacakan `legend-sonza`. Tidak push atau merge. Spesifikasi adalah brief CTO 12 November 2026, PRD lembur, keputusan founder Q42 (distribusi sebelum persetujuan), Q43 (prorata per hari), Q44 (rapel sebelum rilis, kartu terpisah).

Pemilik berkas: implementer components hanya `apps/api/src/services/payroll-components.service.ts`; test-writer hanya `apps/api/src/test/payroll-gross-engine.test.ts`; implementer service-charge hanya service dan test distribusinya; parent menggabungkan, commit, dan menulis progress. Dua Explore memetakan business logic/schema dan concurrency/access.

Urutan deliverable, masing-masing test gagal karena bug yang dimaksud, fix minimum, test hijau, lalu commit lokal:
1. P0: request approved dalam periode, menit 1..720, tarif dayType, agregasi tier harian, cap total terhadap menit absensi valid/accepted hari itu. Absensi 600 tanpa approval menghasilkan 0.
2. P1: irisan tanggal komponen dan periode payroll dengan joinDate..endDate inklusif, pembagi tetap hari kalender payroll, floor agar tidak melebihi nominal.
3. P1/Q42: distribusi pool hanya ke run draft/simulated; hr_approved/approved ditolak tanpa perubahan uang/alokasi.
4. P2: kunci SHARE baris payroll_runs entitas dengan period_end >= effectiveFrom. Cek frozen sesudah kunci, jangan kunci agregat. Buktikan update status menunggu dan effectiveFrom ditolak bila run menjadi frozen.
5. P2: nonaktif melewati earning saja; deduction tetap dipotong (cap net >= 0 tetap).
6. P3: lembur floor ke jam penuh per hari, komentar dan implementasi sama.
7. Rendah: izin sebelum employee lookup (403 termasuk employee asing/tidak ada), dan kunci SHARE run frozen terakhir untuk pembacaan riwayat 8xf32 (commit tersendiri: perluas predicate dengan status frozen, hitung maksimum sesudah lock tanpa percaya urutan SQL).

Review fokus: request ditolak/pending/luar periode tidak dibayar; request berganda tidak menggandakan absensi; batas tepat join/end inklusif; transisi run bersamaan tidak mengubah periode beku; deduction nonaktif tidak menaikkan net. Nilai uang test dihitung manual, bukan dari helper produksi.

Bukti: `LEGEND_TEST_FILES='src/test/payroll-gross-engine.test.ts src/test/payroll-service-charge-distribution.test.ts' heavy pnpm test`, `heavy pnpm --filter @starter/api typecheck`, eslint + prettier pada empat berkas kode dan dokumen berubah. Satu pemilik heavy per thread. Review konteks segar sebelum handoff; re-review architect oleh CTO sesuai brief. Tidak ada perubahan schema yang direncanakan.
