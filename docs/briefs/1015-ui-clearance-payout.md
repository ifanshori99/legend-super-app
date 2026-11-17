# 1015 UI finance: flag recon payout, clearance dua orang, tarik klaim return (legend-o2b4m)

Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md dan ~/.agents/team/ui-standard.md). Opus 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh, plus ui-auditor.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore kontrak + fitur payout web, implementer api/queries/hooks, implementer komponen per layar, test-writer).

Base: `ghostex/1005-payout-tarik-klaim-return` (e6e59f5bf, di atas 990 `ghostex/92055877`). Cabangmu antre SESUDAH 1005.
Mockup disetujui founder (Q28, 17 Nov): `design/mockups/backoffice/payout-recon-clearance.html` + PNG di `origin/ghostex/2a17b0c4` (commit 906b99063; `git show 906b99063 --stat`). Ringkas: `docs/review/mockup-review-payout-clearance.html`. Baca satu layar saat membangun layar itu.
Kontrak: `docs/briefs/990/i2-contract.md` (GET payout-recon-flags, POST .../:flagId/clearance, POST payout-recon-clearances/:clearanceId/approve) dan route tarik klaim return dari 1005 (propose/approve, PAYOUT-94). Pesan error di katalog `ws10-payroll-payout-review`; teks baru masuk katalog (`node --test tests/text-contract.test.mjs`).
Aturan: layar ikut izin yang sama dengan API (roleHasPermission di beforeLoad); tombol setujui disembunyikan dan ditolak untuk pengaju sendiri (API tetap penjaga); password diminta di dialog; tidak ada aksi bayar dari layar ini. Status ubah/dibuka ulang ditampilkan sesuai mockup.
Bukti: test web komponen/hook, satu e2e Playwright alur pengaju lalu penyetuju lain (lewat heavy), screenshot 390 dan 1280 terang/gelap ke docs/review/img/ui1015-*, ui-auditor bersih, prettier/eslint, typecheck web lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): layar, test, temuan architect/ui-auditor, path screenshot, SHA, angka subagent.
