# Brief 268bb: second opinion untuk WS-11 stok, reservasi/delivery, fasilitas (legend-e12h5, legend-lqf0j, legend-60tsm)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Read-only: jangan ubah kode, jangan commit.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran, satu per cabang di bawah.

## Repo

Basis diff semua cabang: `ws/ws11-shared-1` (487c928a). Tiap cabang punya worktree di `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/`. HEAD diisi saat laporan implementer selesai (lihat `__SHA__`).

| Cabang | Worktree | HEAD | Diff |
|---|---|---|---|
| `ws/ws11-inventory-purchasing` (F5) | `ws11-inventory-purchasing` | `__SHA_F5__` | `git diff 487c928a __SHA_F5__` |
| `ws/ws11-reservation-delivery` (F8) | `ws11-reservation-delivery` | `__SHA_F8__` | `git diff 487c928a __SHA_F8__` |
| `ws/ws11-facility` (F10) | `ws11-facility` | `__SHA_F10__` | `git diff 487c928a __SHA_F10__` |

Konteks: `docs/DECISIONS.md` entri 2026-11-10 (butir 1-8), `docs/briefs/sub-ws11-foundation-design.md` §2, `docs/briefs/268-ws11-family-common.md`, `docs/briefs/268b-ws11-stock-reservation-facility.md`. Tes: `LEGEND_TEST_FILES="src/test/ms-<keluarga>.test.ts" pnpm test` dari root worktree.

## Invarian (tingkat K)

1. Satu `MetricSource` per kode; reader selalu menulis baris total (dimensi null) per outlet-hari, nol bila tidak ada aktivitas. Hari tanpa baris total tidak boleh `final`.
2. Total uang yang diposting buku besar tetap dari GL; pecahan non-outlet punya baris residual `__ledger_adjustment__` agar jumlah sama dengan total GL. Pecahan tidak diskalakan pro rata.
3. Metrik uang non-GL (stock_value, purchase_total, supplier_due, delivery_sales, facility_product_revenue, dst.) membaca baris operasional: cek alasan di komentar sumber benar, tanpa hitung ganda dan tanpa pesanan batal/ditolak/void yang ikut terhitung.
4. Isolasi: tenant B tidak melihat/menulis baris tenant A; konteks outlet tidak membaca outlet lain (RLS tetap tembok kedua). Query reader memfilter `tenant_id` dan `outlet_id` eksplisit.
5. Tanggal bisnis: reservasi memakai `reservedFor`, delivery memakai `receivedAt`/`deliveredAt`, fasilitas memakai waktu sesi; konversi ke tanggal bisnis outlet (zona waktu, jam tutup) harus sama dengan reader keluarga lain.
6. Backfill `recomputeMetricsDaily` idempoten; baris dimensi yang hilang dihapus; nilai dimensi maks 200 karakter, id saja, tanpa nama orang atau data pribadi tamu (reservasi).
7. Rasio (`reservation_no_show_pct`, `shower_occupancy_pct`, `shower_fnb_conversion_pct`, `unit_utilization_pct`, `seat_occupancy_pct`): derived dari dua kode terdaftar, null bila penyebut nol, tidak pernah disimpan.
8. F5: helper stok dipindah ke registry tanpa mengubah angka AI (`tl-03-stock-levels`); daftar pengecualian `metric-single-path.test.ts` menyusut sesuai.
9. F8: service delivery dan sinkron platform tidak diubah; data pesanan delivery yang belum final tidak jadi `final`.
10. F10: `web/features/facility-report` dan registry memakai satu sumber angka.

## Keluaran

Temuan per cabang: berkas:baris, skenario gagal konkret, usul perbaikan. Tulis ke `docs/briefs/268bb-second-opinion-ws11-stock-reservation-facility.result.md`. Jangan klaim lulus tanpa menjalankan test yang relevan.
