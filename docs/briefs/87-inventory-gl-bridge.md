# Brief 87: jembatan inventori ke GL (legend-w1vo, tingkat K: uang + migrasi)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dulu.

## Tujuan
Jurnal otomatis untuk selisih stok opname, waste, dan HPP penjualan. PRD J.4. Prasyarat rilis.

## Konteks
- Aturan `stock.adjusted` dan `stock.count` sudah ada di `apps/api/**/posting-rules.ts` (sekitar baris 202), tapi belum ada pemicunya. Waste dan HPP belum punya aturan.
- Basis: buat worktree `.worktrees/inventory-gl` cabang `ws/inventory-gl` dari `milestone/m1` (head 8e2e7bc0, sudah berisi stok opname dan kunci periode).

## Invarian
- Konsumen `stock.moved` idempoten per `sourceType` + id sumber: replay dan retry tidak membuat jurnal ganda.
- Nilai jurnal = nilai yang benar-benar diposting per baris pergerakan, tidak dihitung ulang dari harga rata-rata saat ini.
- Nilai negatif: debit dan kredit dibalik, jangan jurnal dengan angka minus.
- Tunduk kunci periode fiskal (migration kunci periode di main 0063): periode terkunci menolak atau memindah sesuai aturan yang sudah ada, jangan buat jalur baru.
- Semua tabel baru: RLS tenant + FORCE, ikuti pola migration yang ada. Migration baru: `pnpm db:generate` di atas head m1, `when` > 1794153034313.

## Bukti selesai
- Test: opname selisih plus/minus, waste, HPP penjualan, replay idempoten, periode terkunci.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` hijau.
- Reviewer konteks segar (Opus) + architect subagent untuk diff ini; temuan nyata dibetulkan.
- Commit lokal di `ws/inventory-gl`, jangan push, jangan merge ke milestone (CTO yang merge).

## Laporan
SHA, migration baru, ringkasan aturan posting, hasil test, temuan review dan fixnya, yang belum teruji.
