# 818 Perbaikan 3 P1 second opinion edge (Codex, engineer high)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/tax-menu-keyrotation` (87284cbb7). Langkah pertama: `git merge --no-edit origin/ws/edge-master-data-publisher` (eee030082); konflik: hentikan dan lapor. Cabang akhir `fix/edge-so-816` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-i8fv3` (juga mencakup legend-uxpk3). CTO memindah status; kamu tidak menjalankan `bd`.

## Masukan
Laporan `docs/qa/second-opinion-edge-placeholder-resep.md` di repo utama (3 P1, berkas:baris, skenario, usul test). Kerjakan ketiganya sesuai saran laporan. Temuan yang menurutmu salah: buktikan dengan test atau kode, tulis alasannya.

## Prinsip
Alarm panik, pesanan QR, dan kuota Wi-Fi tidak boleh macet, hilang, atau tergeser. Data brand/tenant lain tidak boleh sampai ke edge yang salah. Untuk P1-3 (tenant > 200 brand): jangan sampai seluruh snapshot master (uoms, CoA) hilang; pilih pagination/streaming atau batas yang tetap mengirim data non-brand.

## Scope
- Boleh: kode edge sync/link/katalog/snapshot di `apps/api/src/edge*`, `apps/api/src/services/edge*`, `packages/shared/src/edge`, test edge.
- Migrasi baru hanya bila tak terhindarkan: nomor 0379, laporkan.
- Jangan: alarm panik push (thread lain), pembayaran, payout, pemindai, AI.

## Paralel
Subagent bawaan Codex (maks 6): satu per temuan (file tidak bertumpuk) + satu test-writer gagal-dulu + satu reviewer.

## Bukti selesai
- Test gagal-dulu per temuan, merah di basis (catat).
- `LEGEND_TEST_FILES="<semua edge-* yang tersentuh>" heavy pnpm test` hijau.
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` (dan shared bila berubah).

## Laporan
Per temuan: perbaikan + test. SHA, cabang akhir, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor hanya saat selesai atau butuh keputusan.
