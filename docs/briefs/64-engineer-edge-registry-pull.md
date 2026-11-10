# Brief: engineer — tarik device registry berkala di runtime edge (legend-2lp.7)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-registry-pull`, cabang `ws/edge-registry-pull` (dari `ws/edge-hardening` 2536ec6). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
Urutan merge wajib: `ws/edge-hardening` → legend-2lp.7 → `ws/device-registry`. Bila device registry masuk tanpa tarik berkala, semua token device di edge ditolak (replica lokal kosong). Cabang ini menyatukan ketiganya supaya bisa di-merge sekali dengan aman:
1. `git merge --no-ff ws/device-registry` (7caa7be) ke cabang ini. Bentrok nomor migration: renumber via drizzle-kit per `HANDOFF.md` §5, jangan edit `_journal.json` tangan.
2. Panggil `pullDeviceRegistry` (`services/edge-device-sync.ts`) dari `src/edge/runtime.ts` saat boot dan tiap N detik (konfigurasi, default wajar) dengan kredensial edge; simpan watermark; alert/health bila tarik sukses terakhir basi. Detail: `bd show legend-2lp.7`.

## Kartu
`legend-2lp.7`. Di awal: `ghostex board associate legend-2lp.7`, `bd update legend-2lp.7 --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (auth/keamanan)
- Gagal tarik: tetap fail-closed (jangan buka akses device), tapi replica lama tetap dipakai sampai basi; status basi terlihat di `/api/edge/status`.
- Timer tidak tumpang tindih (satu tarik berjalan sekaligus), backoff saat cloud mati, berhenti bersih saat shutdown.
- Jangan baca `.env*`.

## Scope
- Boleh: `apps/api/src/edge/**`, `apps/api/src/services/edge-device-sync*.ts`, konfigurasi edge, test edge terkait, hasil merge device-registry.
- Jangan: `apps/web/`, POS, payment, payroll, akuntansi.

## Bukti selesai
- Test: boot memanggil tarik; interval berjalan dan tidak tumpang tindih; watermark tersimpan dan dipakai; gagal tarik tidak menghapus replica; status basi muncul; token device valid diterima setelah tarik pertama (staff-pins/verify, heartbeat).
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/edge-registry-pull`, hanya file dalam scope. Pesan commit merujuk legend-2lp.7.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit, migration yang di-renumber, risiko tersisa, yang dibutuhkan dari CTO.
