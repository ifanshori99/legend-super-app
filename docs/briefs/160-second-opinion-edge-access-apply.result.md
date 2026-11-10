# Hasil second opinion 160 — cloud menerapkan event akses edge

Bersih dari temuan P1/P2 baru pada perubahan asal brief 160. Temuan pada aturan lock yang ditambahkan brief 188b dicatat satu kali di [hasil 188b](188b-second-opinion-edge-pin-pull.result.md), bukan dihitung ulang di sini.

- Run gabungan: brief 218, mengikuti prosedur 217; 9 November 2026.
- Rentang: `2216e2b7..09658266` dan `09658266..19087b75`.
- Milestone diperiksa: `milestone/m1` pada `94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`.
- Pemeriksa: satu subagent Codex khusus 160; parent memeriksa kembali kode, migrasi, serta temuan lintas brief. Empat subagent pada run gabungan, puncak empat bersamaan.

| Id brief | Kartu | Hasil | Kartu baru yang dibuat | Catatan singkat |
| --- | --- | --- | --- | --- |
| 160 | legend-kyie | Bersih | Tidak ada | Migrasi sudah dinomori ulang; temuan lock tambahan ada pada hasil 188b. |

## Jawaban pemeriksaan

- Sequence longgar: receipt tenant-wide pada `apps/api/src/edge/db-link-store.ts:282` dan `:358` tetap menduplikasi event ID di dalam transaksi yang sama. Event yang sama dari dua node tidak menggandakan efek yang berhasil commit. Set memakai row lock dan perbandingan generation/sequence (`apps/api/src/edge/access-applier.ts:242`, `:281`). Penerapan lock dari sequence lama sesudah reset memerlukan koreksi tambahan pada perubahan 188b; lihat `legend-lhffb` di hasil 188b.
- Audit override: produsen mengunci idempotency lalu mengecek replay (`apps/api/src/services/staff-override.service.ts:630`); penyelesaian phone approval hanya berpindah dari pending sekali (`:754`). Calon race dedupe audit SELECT lalu INSERT tidak dilaporkan: belum ditemukan jalur produsen yang membuat dua event ID berbeda untuk override yang sama. Replay mempertahankan event ID dan dilindungi receipt.
- Migrasi: bentrok nomor lama diselesaikan pada merge `575fb0ed`. SQL aktual adalah `apps/api/drizzle/0141_great_firedrake.sql:1` dan `0142_high_scrambler.sql:1`. Backfill mengangkat FORCE RLS sementara lalu memasangnya kembali (`0141:10–14`, `0142:6–10`). Review SQL tidak menemukan penghapusan data atau FORCE RLS yang tertinggal mati.
- Batas jam lima menit: set di depan batas ditolak (`access-applier.ts:212`), lock di depan batas diabaikan (`:397`). Ini membatasi generation masa depan; kecukupan operasionalnya bergantung pada jam outlet. Sisa skew yang sudah berkartu tidak dilaporkan ulang.
- Keanggotaan historis: applier menerima role yang sudah berakhir untuk merekam kejadian offline (`access-applier.ts:146`). Verifikasi PIN masih mengecek akun dan keanggotaan aktif (`apps/api/src/services/device-pin.service.ts:470`, `device-pin-support.ts:62`); penerimaan event tidak memberikan login sendiri.
- Scope dan redaksi: arah/tenant/outlet/node diperiksa oleh `assertEdgeEventScope`; konflik, baris parkir dan drain meredaksi material. Arah antrean menuju perangkat menolak material PIN (`apps/api/src/services/edge-queue.service.ts:122`). Error tulisan material dibungkus tanpa detail driver.
- Drain: savepoint per baris menjaga event live dari kegagalan baris parkir (`access-applier.ts:527`). Keterbatasan drain lazy dan observabilitas sudah berkartu; tidak diduplikasi.

## Deduplikasi dan batas verifikasi

- `bd search` untuk PIN, override, audit, dedup, duplicate, ganda, lock, clock, skew dan drain; konteks yang dikecualikan brief 218 tidak dilaporkan ulang.
- Review melalui `git diff`, `git show`, riwayat perubahan sesudah tip dan pembacaan test. Parent memeriksa SQL migrasi aktual dan kode receipt/guard yang relevan.
- Tidak menjalankan migrasi, suite aplikasi, build, atau failover database. “Bersih” berarti tidak ada temuan baru P1/P2 pada scope perubahan ini, bukan klaim gate test lulus.
- Hanya berkas hasil ini yang ditulis untuk brief 160; tidak ada kode, checkout, commit, merge, push atau penutupan kartu.
