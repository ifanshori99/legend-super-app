# Brief: ui-engineer — UI kasir: alur shift baru + modal Rp0 (legend-iqi)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Aturan UI: `~/.agents/team/ui-standard.md`. Konvensi: `AGENTS.md`, `DESIGN.md`, `docs/frontend.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-kasir-shift`, cabang `ui/pos-kasir-shift` (dari `ui/pos-kasir` 3f5c91e, yang sudah disetujui founder dan sedang di-merge ke `main`). Jangan pindah cabang. Setup: `pnpm install --offline --frozen-lockfile`; jangan symlink `node_modules`.

## Tujuan
Sesuaikan UI kasir POS (brief 19, 21 layar, mode mock) dengan kontrak shift baru di cabang `ws/pos-shift` 580d0db (belum merge, sedang second-opinion) dan keputusan founder:
1. Tunai butuh shift terbuka: tanpa shift terbuka, tombol/alur tunai mengarahkan ke Buka shift; tangani 409 `SHIFT_NOT_OPEN` dengan pesan jelas.
2. Tutup shift 2 langkah: hitung buta per pecahan (POST `.../shifts/:shiftId/counts`, dapat `countId`), lalu tutup dengan `countId`.
3. Founder Q2 (8 Nov): buka shift dengan modal Rp0 BOLEH, dengan satu konfirmasi tambahan sekali sebelum shift dibuka (dialog jelas, bukan blokir).
Ambil bentuk request/response dari `packages/shared` di cabang `ws/pos-shift` (baca saja lewat `git show ws/pos-shift:<path>`); tiru di mock. Jangan salin kode API.

## Kartu
`legend-iqi`. Di awal: `ghostex board associate legend-iqi` dan `bd update legend-iqi --status in_progress`. Saat melapor: `bd update legend-iqi --status review` dan `bd comment legend-iqi "<ringkasan bahasa biasa>"`.

## Masukan
- Mockup shift: `design/mockups/pos/` (buka shift, shift aktif, tutup shift hitung buta, supervisor, tutup hari). Ubah tampilan seminimal mungkin dari yang disetujui.
- Layar yang ada: `apps/web/src/routes/_ops/pos*`, feature POS web.

## Scope
- Boleh: `apps/web/src/routes/_ops/pos*`, feature/komponen web POS, mock POS, i18n pesan POS, e2e mock POS terkait.
- Jangan: `apps/api/`, skema/validator `packages/shared` (kecuali file pesan i18n), `_customer/`, `design/`.

## Bukti selesai
- Screenshot 1280x800 sebelum/sesudah: buka shift Rp0 + konfirmasi, tunai tanpa shift, tutup shift langkah 1 dan 2, 409 `SHIFT_NOT_OPEN`.
- e2e mock POS untuk alur di atas; `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent `ui-auditor` dan reviewer konteks segar; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ui/pos-kasir-shift`, hanya file dalam scope. Pesan commit merujuk legend-iqi.

## Laporan
Hasil, path screenshot, bukti (perintah dan hasil), file berubah, commit, kebutuhan kontrak yang belum ada, risiko tersisa.
