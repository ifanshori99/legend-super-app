# Hasil second opinion 183b — sinkron PIN dan audit override edge

Temuan: satu P1 baru, `legend-gauz3`.

- Run gabungan: brief 218, mengikuti prosedur 217; 9 November 2026.
- Rentang: `bddf8442..e420469e`.
- Milestone diperiksa: `milestone/m1` pada `94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`; temuan masih ada di milestone tersebut.
- Pemeriksa: satu subagent Codex khusus 183b; parent memeriksa jalur transaksi dan menjalankan reproduksi terisolasi. Empat subagent pada run gabungan, puncak empat bersamaan.

| Id brief | Kartu | Hasil | Kartu baru yang dibuat | Catatan singkat |
| --- | --- | --- | --- | --- |
| 183b | legend-t9ii, legend-7iti, legend-zclb | Temuan | legend-gauz3 (P1) | Job resend dapat memancarkan material PIN lama sesudah reset baru. |

## Temuan P1/P2

- `apps/api/src/edge/staff-pin-resend.ts:74` — **P1, legend-gauz3:** material dibaca tanpa row lock; reset B dapat commit setelah job membaca A dan latest event v1, lalu job menambahkan A dengan sequence lebih tinggi sehingga cloud mengaktifkan kembali PIN lama. Ambil `FOR UPDATE` sebelum membaca material/latest dan tahan sampai append selesai; tambah regresi konkuren.

### Skenario dan bukti parent

1. Job R membaca baris PIN A (`staff-pin-resend.ts:74`) dan latest set tanpa material (`:88`). Lock advisory `staff-pin-resend:<tenant>:<outlet>` hanya menyerialkan sesama job resend.
2. Reset normal W memperoleh row lock (`apps/api/src/services/device-pin.service.ts:220`), menyimpan B dan commit dengan sequence `n+1`; W tidak mengambil advisory lock R.
3. R melanjutkan append memakai snapshot A. `appendDevicePinEvent` membaca `max(sequence)+1` (`apps/api/src/services/device-pin-support.ts:142`) dan menghasilkan sequence `n+2`. Helper mengharuskan caller memegang row lock (`:124`), tetapi R belum memegangnya.
4. Cloud menerima B lalu A: predicate same-node di `apps/api/src/edge/access-applier.ts:281` menerima sequence lebih tinggi meski `setAt` lebih lama. PIN lama berlaku lagi dan lock/counter cloud dibersihkan.

Parent menjalankan source aktual `resendMateriallessStaffPinSets` dan `appendDevicePinEvent` dari SHA milestone tersebut dengan port DB/Drizzle tiruan. Interleaving yang dihasilkan:

```text
R reads PIN row A without a row lock
R reads latest materialless event A
W resets PIN to B and commits sequence 2 before R appends
R emits material A with sequence 3
```

Assertion memastikan baris lokal tetap B, event terakhir membawa A, dan sequence terakhir 3. Ini membuktikan stale snapshot pada jalur fungsi aktual; belum merupakan regresi PostgreSQL atau verifikasi cloud end-to-end.

## Jawaban pertanyaan brief

- `xid8` + `pg_snapshot_xmin`: ekspor memfilter `sync_xid < xmin` (`apps/api/src/services/staff-pin-sync.ts:370`), sehingga transaksi lama yang belum selesai menunda ekspor alih-alih dilewati watermark. Trigger migrasi `0151_staff_pin_sync_xid.sql:15` mencatat xid penulis setiap update. Tidak menemukan temuan baru pada keyset/horizon ini.
- Restore dan replika: epoch yang berbeda memulai resync. Dump/restore ke cluster baru masih memerlukan restamp seluruh `sync_xid`, karena nilai yang dipulihkan dapat berada di atas counter cluster baru. Runbook restamp, durability, timeout transaksi idle dan alert horizon sudah ada di `docs/deployment.md:236`. Transaksi panjang menunda semua ekspor yang tertahan horizon; ini bukan jaminan latensi.
- Urutan rilis: cloud, migrasi dan penerima material dahulu, kemudian edge. Konsumen schema strict versi lama belum mengenal `pinGenerationAt`; rollout harus memperhitungkan jeda pembaruan parser. Urutan tertulis pada `docs/deployment.md:239`; kompatibilitas campuran versi tidak diuji di run ini.
- Audit `cash_shift_close`: material blind-count variance dibawa hanya pada jalur edge ke cloud; audit cloud mencatat expected, counted dan variance. Jalur cloud/perangkat tetap meredaksi angka blind count. Tidak ditemukan temuan baru pada legend-7iti.

## Deduplikasi dan batas verifikasi

- `bd search` untuk PIN, resend, pengiriman ulang, PIN lama, race, resendMateriallessStaffPinSets dan material lama; tidak ada kartu race setara. `legend-zclb` adalah fitur asal, bukan skenario race ini. Kartu baru dibuat parent setelah pemeriksaan.
- Review statis, riwayat Git dan harness fungsi aktual di atas sudah dijalankan. Tidak menjalankan suite aplikasi, PostgreSQL konkuren, restore/failover nyata, build atau rollout campuran versi.
- Hanya berkas hasil ini dan kartu temuan yang dibuat; kode tidak diubah. Tidak checkout, commit, merge, push atau menutup kartu.
