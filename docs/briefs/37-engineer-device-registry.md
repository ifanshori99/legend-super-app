# Brief: engineer — registri perangkat, heartbeat, pencabutan offline, mode latihan (legend-165)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/device-registry`, cabang `ws/device-registry` (dari `main`). Jangan pindah cabang.

## Tujuan
PRD v1.7 §3 F5 Registri Perangkat + Mode Latihan, §6 A devices (`docs/PRD.md`): enrollment perangkat, ingest heartbeat + deteksi offline, daftar pencabutan yang direplikasi ke edge dan ditegakkan tanpa internet, data mode latihan dikecualikan dari laporan. Detail dan catatan review: `bd show legend-165`.

**Wajib (temuan keamanan):** `deviceTenantCredential` (`apps/api/src/services/platform-tenant.service.ts`) dan verifier `apps/api/src/lib/device-token.ts` (dv1, TTL 90 hari) belum mengecek registri. Tambahkan cek deviceId aktif, tidak dicabut, tenant cocok sebelum token diterbitkan, dan saat token dipakai (termasuk di edge saat offline).

## Kartu
`legend-165`. Di awal: `ghostex board associate legend-165` dan `bd update legend-165 --status in_progress`. Saat melapor: `bd update legend-165 --status review` dan `bd comment legend-165 "<ringkasan bahasa biasa>"`.

## Catatan
- Area keamanan: plan singkat dulu. Gagal tertutup (perangkat tidak dikenal = tolak).
- Cabang `ws/edge-hardening` (belum merge) mengubah `edge/mode.ts`, edge link dan staff-pin sync. Jangan sentuh file itu; bila perlu titik sambung, catat sebagai bead lanjutan.
- Migration: drizzle-kit, jangan edit `_journal.json`; nomor dirapikan saat merge. Rahasia: jangan baca `.env*`.

## Scope
- Boleh: schema/migration device, `services/device*.ts` / `edge-device*.ts`, `lib/device-token.ts`, `platform-tenant.service.ts` (bagian credential), route device, test `apps/api/src/test/device*.test.ts`, kontrak `packages/shared` untuk device.
- Jangan: `apps/web/`, `design/`, file POS/payment/KDS, file cabang edge-hardening.

## Bukti selesai
- Test: enroll, heartbeat, offline terdeteksi, perangkat dicabut ditolak saat terbit token dan saat pakai (online dan offline di edge), tenant salah ditolak, data latihan tidak masuk laporan, isolasi lintas tenant/outlet.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/device-registry`, pesan merujuk `legend-165`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, bead lanjutan, risiko tersisa.
