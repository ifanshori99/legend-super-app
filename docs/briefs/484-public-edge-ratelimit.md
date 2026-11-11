# 484 Public edge / rate-limit hardening

Peran: engineer (`~/.agents/team/roles/engineer.md`). Worktree sendiri dari `origin/milestone/m1`, cabang `ws/public-ratelimit`. Tanpa migrasi.

Kartu (selesaikan semua, lalu lapor):
- legend-bpvf: jendela rate-limit bersama antar instance API (Redis), `apps/api/src/middleware/public-rate-limit.ts`.
- legend-moe5: teruskan IP pengunjung dari SSR ke API (`apps/web/**/upstream.server.ts`); API hanya percaya header dari SSR yang terautentikasi, bukan dari klien.
- legend-vz93: HTML publik per tenant yang bisa di-cache (header cache benar, tidak bocor antar tenant).
bpvf dan moe5 menyentuh berkas sama: berurutan. vz93 paralel.

Paralel: Explore 1, test-writer (gagal-dulu tiap kartu), implementer per kartu, reviewer sonnet per area. Test terarah lewat `heavy`. Gate lint per cabang: `pnpm exec eslint` + `prettier --check` berkas berubah. Langkah 1: `bd show` + `git log --all --oneline | grep <id>` cek basi. Update `docs/deployment.md` bila konfigurasi berubah. Laporan: commit, test, angka subagent.
