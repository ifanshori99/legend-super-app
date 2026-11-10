# Brief: engineer (Sonnet) — pickup display feed + call/picked-up/delivered (legend-mzhr0)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pickup-feed-service` dari `ws/expo-pickup-tables` 6f916193 (tabel `pickup_calls`/`expo_assignments`, migrasi 0168, di atas kontrak usw3 4fe23687). Worktree `.worktrees/pickup-feed-service`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-mzhr0` (P2, WS-04 BE). Baca `bd show legend-mzhr0` dan `bd comments legend-mzhr0` (catatan desain dari thread tabel: alokasi nomor MAX+1 butuh advisory lock + retry 23505; perilaku sesudah nomor 999; status order void). Kontrak: `packages/shared/src/kitchen/schemas.ts` (pickup, `PICKUP_CALL_TRANSITIONS`, promotions :595 :609).
- Service + route sesuai kartu: feed display pickup, aksi call / picked-up / delivered, promotions display-safe dari promo engine (tanpa kode/anggaran).
- Keputusan teknis kecil (999, void) ambil sendiri yang aman dan sebut di laporan; yang berdampak bisnis: lapor.

## Kartu
Di awal: `bd update legend-mzhr0 --status in_progress`. Saat melapor: `--status review` + `bd comment`. Sisa kerja: kartu baru.

## Scope
Boleh: `services/pickup*.service.ts`, `routes/pickup*.routes.ts`, `test/pickup*.test.ts`, kontrak shared kitchen bila bug nyata (lapor). Jangan: migrasi baru (butuh kolom/tabel: berhenti dan lapor), expo runner (`legend-him8j`), edge allowlist (`legend-64i1`), UI.

## Bukti selesai
- Test: isolasi tenant/outlet, nomor unik tanpa balapan (paralel), transisi status sah/tidak sah, promosi tidak membocorkan kode atau anggaran, izin route.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file; sertakan `src/test/expo-pickup-rls.test.ts`.
- tsc lewat `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review (aturan Q48): satu subagent `reviewer` sonnet; bila menyentuh alokasi nomor dokumen secara konkuren, pakai satu `architect` sebagai gantinya.

## Laporan
Sekali: endpoint, keputusan kecil, bukti, file berubah, SHA, kartu sisa, jumlah subagent.
