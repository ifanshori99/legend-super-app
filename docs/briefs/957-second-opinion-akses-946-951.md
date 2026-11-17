# 957 Second opinion akses 946 + 951 (gerbang rilis akses)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Effort high. Read-only kecuali berkas hasil.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Worktree sendiri dari `origin/milestone/m1`.
Diff:
- 946: `git diff 8a661cd90..origin/ghostex/a46177dd` (perbaikan P1 SO 944: perangkat tanpa sesi ditolak saat registry hard-stale; status registry "belum siap"). Brief: docs/briefs/946-edge-stale-so944-fix.md.
- 951: `git diff c17c60df7..origin/ghostex/ws-01-pengerasan-akses-951` (legend-ijcxc pencabutan izin manajer, p0ms5 email peminta, d3quc dokumen pemegang saham, tetyr rotasi kunci enkripsi). Brief: docs/briefs/951-ws01-access-hardening.md.
Diterima CTO (jangan dilaporkan): 4 kolom tersegel di tabel beku belum dirotasi, menunggu fungsi SECURITY DEFINER sempit (legend-4vfmn); desain envelope byte tetyr; alert batas basi ke cloud (legend-uvnll).
Cari: izin yang dicabut masih lolos (race, cache, sesi lama); data pribadi bocor lintas tenant atau ke peran tanpa izin (cek filter SQL, bukan hanya route); kunci lama dipensiunkan sebelum semua data pindah, atau rotasi yang bisa kehilangan data; jalur perangkat yang melewati batas basi; sesi berjalan diputus di tengah transaksi; token acting-staff tertulis saat ditolak.
Hasil: `docs/qa/second-opinion-akses-946-951.md` (P0-P3, berkas:baris, skenario, usul test), commit dan push cabang `qa/second-opinion-akses-946-951` tanpa force. Lapor hanya saat selesai.
