# Brief: engineer (Sonnet) — API simpan stasiun dapur + kontrak pemindai (legend-bopi2, legend-tzyj2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Satu implementer per kartu, reviewer sonnet di akhir.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri dari `origin/ui/kds-config-scanner` (bad105c02): `git worktree add -b ws/kds-station-save .worktrees/kds-station-save origin/ui/kds-config-scanner`.

## Tujuan
1. legend-bopi2: endpoint simpan `updateKitchenStations` (urutan tab, aktif/nonaktif, cetak cadangan per stasiun) yang dipakai layar `/kelola/dapur/stasiun` (`apps/web/src/features/ws04-kitchen-config/`). Ikuti pola AGENTS.md (validator strict di shared, service filter tenant/outlet di SQL, `requireAuth` + `requireTrustedOrigin` + `requirePermission`). Tolak simpan bila tidak ada stasiun aktif (aturan sama dengan UI). Sambungkan UI ke endpoint ini (hapus mode baca-saja di luar mock).
2. legend-tzyj2: sumber status pemindai dan kode tiket pendek. Selidiki dulu. Bila kode pendek butuh kolom/migrasi baru: JANGAN buat migrasi, berhenti untuk kartu ini dan laporkan usulan (nama kolom, keunikan per outlet/hari) ke CTO.

Tanpa uang. Bila bopi2 butuh migrasi, laporkan dulu sebelum membuat.

## Bukti, sebelum melapor
Test API gagal-dulu (simpan, tenant lain ditolak, semua nonaktif ditolak), test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru, typecheck api dan web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `ws/kds-station-save` tanpa force. Jangan merge, jangan deploy.
