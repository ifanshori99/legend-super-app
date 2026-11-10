# Hasil second opinion 188b — penarik PIN dan adopsi set edge

Temuan: dua P2 baru, `legend-r11j7` dan `legend-lhffb`.

- Run gabungan: brief 218, mengikuti prosedur 217; 9 November 2026.
- Rentang: `12c91f6b..e32874a6`.
- Milestone diperiksa: `milestone/m1` pada `94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`.
- File inti `staff-pin-sync.ts`, `staff-pin-pull.ts`, `access-applier.ts` dan `device-pin.service.ts` tidak berubah lagi antara tip brief dan SHA milestone tersebut.
- Pemeriksa: satu subagent khusus 188b; parent memeriksa kedua calon temuan dan menjalankan harness/predicate. Subagent 160 memverifikasi silang reachability lock lama. Empat subagent pada run gabungan, puncak empat bersamaan.

| Id brief | Kartu | Hasil | Kartu baru yang dibuat | Catatan singkat |
| --- | --- | --- | --- | --- |
| 188b | legend-yvhw8, legend-kgbw, legend-rucdm, legend-7vv8h, legend-4z2ch | Temuan | legend-r11j7 (P2), legend-lhffb (P2) | Counter ABA hilang; lock lama dapat melewati reset. |

## Temuan P1/P2

- `apps/api/src/services/staff-pin-sync.ts:593` — **P2, legend-r11j7:** cloud `3→0→3` di antara dua pull dianggap replay ketika baseline edge masih 3 dan counter edge sudah dibersihkan ke 0; tiga kegagalan baru tidak diterapkan. Replikasi revision khusus state percobaan/reset dan simpan revision baseline; jangan hanya membandingkan nilai atau memakai `sync_xid` yang juga berubah saat re-ekspor tanpa mutasi state.
- `apps/api/src/edge/access-applier.ts:395` — **P2, legend-lhffb:** lock node asal dengan sequence lebih rendah tetap lolos melalui cabang timestamp, sehingga backlog lock sebelum reset dapat mengunci PIN baru setelah jam edge mundur. Untuk node/instance asal yang sama, tolak sequence lock ≤ sequence generation set sebelum pembandingan timestamp; tambah regresi lintas batas drain.

### Bukti parent: counter ABA

1. Edge menerima counter cloud 3; `cloud_failed_attempts=3`.
2. PIN benar di edge membersihkan counter lokal menjadi 0.
3. Sebelum pull berikutnya, cloud menerima PIN benar (`3→0`) lalu tiga kegagalan baru (`0→3`). Edge tidak melihat 0.
4. `record.failedAttempts !== local.cloudFailedAttempts` salah; generation/material/lock juga sama. Baris dilewati dan edge tetap 0.

Parent menjalankan source aktual `applyStaffPinRecords` dari SHA di atas dengan port DB/Drizzle tiruan. Hasil assertion: `applied=0`, `skipped=1`, `writes=0`, counter edge tetap 0. Test existing `apps/api/src/test/staff-pin-sync-resync.test.ts:258` hanya mencakup nilai akhir berbeda (`3→0→2`); test `:275` melihat reset 0 terlebih dahulu. Keduanya belum mencakup ABA yang tidak terlihat.

### Bukti parent dan review silang: lock sebelum reset

Skenario ini mengikuti cloud-first deploy dan memperhitungkan startup resend, tanpa memerlukan hash yang diparkir cloud lama:

1. Edge lama menghasilkan E1 v1 `seq1` pada 11:59, lalu lock L `seq2`, `occurredAt=11:59:30`, `lockedUntil=12:14:30`. Cloud lama memarkirkannya; cloud belum punya PIN staf itu. Ada 51 baris akses sebelum L dalam backlog.
2. Cloud di-upgrade lalu edge; jam edge dikoreksi mundur ke 11:04, jam cloud 12:00.
3. Startup resend E1 menghasilkan A `seq3`, `setAt=11:04` (`apps/api/src/edge/staff-pin-resend.ts:138`). Handler menguras 25 baris lalu memasukkan A.
4. Reset E2 menghasilkan B `seq4`, key `11:09:00.001` melalui cap setter (`apps/api/src/services/device-pin.service.ts:290`, tanpa cloud generation yang lebih tinggi). Handler menguras 25 baris lagi lalu mengadopsi B; L masih tertinggal.
5. Drain berikutnya menerapkan L. Timestamp `11:59:30 > 11:09:00.001` meloloskan predicate `:395`, walau `seq2 < seq4`. B terkunci kembali sampai 12:14:30. Batas skew lolos karena occurredAt L lebih lama dari cloud now dan lockedUntil masih aktif.

Parent memeriksa `DRAIN_LIMIT=25`, pengambilan backlog (`access-applier.ts:549`), drain sebelum live (`:617`) dan apply parked langsung (`:556`); receipt dari pemarkiran lama tidak meniadakan drain. Parent juga menjalankan source aktual `applyStaffPinLocked` dengan port DB/Drizzle tiruan yang mengevaluasi predicate SQL yang dihasilkan: lock sequence 2 pada generation sequence 4 menghasilkan `outcome=applied` dan `failedAttempts=5`. Jalur backlog ini juga diverifikasi silang oleh subagent 160. Harness ini belum menguji SQL terhadap PostgreSQL.

## Jawaban pertanyaan brief

- Adopsi per node: guard set (`access-applier.ts:281`) menolak sequence lama dari node asal dan mengadopsi sequence lebih tinggi meski key mundur. Celah berbeda masih ada pada guard lock di atas. Batas rebuild DB/id node sama sudah memiliki kartu yang dikecualikan brief 218 dan tidak dilaporkan ulang.
- Re-ekspor `legend-kgbw`: penolakan dengan material berbeda menyentuh baris cloud (`access-applier.ts:291`), sehingga satu penolakan menambah satu write dan ekspor ulang. Material identik tidak ditulis. Apply cloud maupun edge tidak memancarkan event; tidak menemukan loop otomatis baru.
- Baseline `legend-7vv8h`: replay nilai sama tidak mengembalikan state edge yang sudah dibersihkan; tetapi nilai saja tidak membedakan mutasi baru yang kembali ke baseline, seperti temuan ABA di atas.
- Penarik: primary dan standby dipasang di runtime; halaman diterapkan sebelum checkpoint akhir disimpan, dan cursor awal yang ditolak memicu restart sekali. Tidak menemukan temuan baru pada checkpoint/paging.
- `legend-li03g` masih mencakup penggantian sementara set lokal yang belum di-ack oleh gema cloud. Itu temuan yang sudah berkartu dan tidak dibuat ulang.

## Deduplikasi dan batas verifikasi

- `bd search` PIN, baseline, counter, lock, staff_pin.locked dan sequence. `legend-7vv8h` mengatasi replay state lama yang memulihkan counter/lock edge; dua temuan ini berbeda: kegagalan baru hilang dan lock generasi lama diterapkan di cloud. Parent membuat kedua kartu setelah verifikasi.
- Review Git/kode dan dua harness fungsi aktual dengan port tiruan sudah dijalankan, termasuk evaluasi predicate lock. Tidak menjalankan suite aplikasi, PostgreSQL end-to-end/backlog, build, restore atau failover nyata.
- Hanya berkas hasil ini dan kartu temuan yang dibuat; kode tidak diubah. Tidak checkout, commit, merge, push atau menutup kartu.
