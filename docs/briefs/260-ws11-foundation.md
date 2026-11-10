# Brief: engineer (Opus) — WS-11 fondasi laporan dan metrik (kartu A)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/ws11-foundation` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/ws11-foundation`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Nomor migrasi dipesan: `0176`, `when` 1794255000000. Hanya tabel baru.

## Konteks
Baca `docs/briefs/259-ws11-card-split.md` seluruhnya: kondisi m1, pecahan kartu, risiko. Kartu ini (A) jalan sendirian dulu; F1-F12 menunggu hasilnya dan memakai berkas keluarga masing-masing.

## Tujuan
1. Keputusan desain dulu, lewat satu subagent `architect`, dicatat di `docs/DECISIONS.md`: risiko 1-4 di berkas 259 (pecahan non-outlet dari data pesanan dengan total GL sebagai kontrol; satu registry untuk dasbor, laporan, dan AI; `metrics_daily` + batch; kepemilikan berkas).
2. Registry sumber metrik: `apps/api/src/services/metric-sources/index.ts` + `types.ts` + 10 berkas stub keluarga (sales, traffic-operations, menu-cogs, payments-tax, inventory-purchasing, finance, loyalty-crm, reservation-delivery, hr, facility), masing-masing kosong tetapi terdaftar. `metrics-query.service.ts` memakai registry; 12 metrik GL yang sudah jalan tetap sama (regresi).
3. Tabel `metrics_daily` (tenant, outlet, tanggal, metrik, nilai, status closed/estimate) + job agregasi harian, RLS tenant/outlet dipaksa.
4. Report run API dari kontrak `packages/shared/src/dashboard/endpoints.ts`: catalog, get, run, preview (`routes/reports.routes.ts`, `services/report-run.service.ts`), izin dan cakupan outlet seperti `metrics.routes.ts`. Laporan yang sumbernya belum ada menjawab status "belum tersedia" yang jelas, bukan angka palsu.
5. Pecah `apps/web/src/lib/mock/.../mock-day-model.ts` per keluarga ke `apps/web/src/features/ws11-reports/mock-families/<keluarga>.ts` tanpa mengubah perilaku, supaya F1-F12 tidak bentrok.
6. Buat kartu bd sesuai tabel berkas 259 (F1-F12, INT) dengan `bd dep add` ke kartu A dan dependensi kerasnya; komentari kartu lama yang diserap dengan "diserap ke <id>". Kartu A sendiri: buat dulu dengan judul dari tabel, lalu `ghostex board associate`.

## Kartu
Awal: buat kartu A, `bd update <A> --status in_progress`, komentari legend-31fi, legend-cdta, legend-24nl, legend-atcu. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: `services/metrics*`, `services/metric-sources/`, `services/report-run.service.ts`, `routes/reports.routes.ts`, `db/schema/metrics.ts`, migrasi 0176, `packages/shared/src/dashboard/*` dan `metrics/*` (kamu satu-satunya pemilik), mock web ws11 (pemecahan saja), test, `docs/DECISIONS.md`. Jangan: isi metrik keluarga (itu F1-F12), dasbor API (F11), ekspor/jadwal (F12), UI baru.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: run laporan per tenant/outlet terisolasi; 12 metrik GL regresi; job metrics_daily idempoten; laporan tanpa sumber menjawab "belum tersedia".
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah: lewat `pnpm test`.
- Typecheck api, web, shared lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect` untuk diff. Pakai subagent paralel (Explore per area, implementer per potongan berkas) sesuai "Paralel dulu".
- Tulis brief Codex `docs/briefs/260b-second-opinion-ws11-foundation.md`, jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain (ringkas), SHA, migrasi (`when`, prevId), id kartu A/F1-F12/INT, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
