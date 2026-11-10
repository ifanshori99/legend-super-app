# 160: second opinion, cloud menerapkan event akses dari edge (legend-kyie)

Tingkat K (PIN staf: hash rahasia, auth offline, audit, migrasi). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang

- Cabang `ws/edge-access-apply`, worktree `.worktrees/edge-access-apply`.
- Basis `2216e2b7` (ws/edge-event-class) sampai `09658266`.
- `git diff 2216e2b7..09658266`
- Migrasi: `apps/api/drizzle/0134_white_oracle.sql`. Nomor 0134 BENTROK dengan `milestone/m1` (0134-0139) dan `ws/refund-tier` (0134-0135). Harus diberi nomor ulang di merge train; isinya tidak menyentuh tabel yang sama dengan migrasi lain.

## Masalah

Event edge `staff_pin.set`, `staff_pin.locked` dan `pos_override.recorded` hanya diparkir di cloud. Akibatnya:
- PIN yang di-set di edge bisa kembali ke nilai lama setelah standby ambil alih.
- Lock PIN di edge hilang setelah standby ambil alih.
- Override yang terjadi offline tidak masuk audit cloud.

## Desain (architect) dan implementasi

1. Transport PIN:
   - `staff_pin.set` mendapat field opsional `material` (algorithm, salt, pinHash, params, pepperVersion, setAt), tanpa naik versi. Hanya proses edge yang mengisinya (`isEdgeProcess()`).
   - Hash = HMAC dengan pepper per tenant, lalu scrypt, terikat ke tenant, outlet dan user. Pepper edge dan cloud sama.
   - Cloud sudah lebih dulu mengirim data yang sama ke edge (`staff-pin-sync.ts`).
2. Redaksi:
   - `redactEdgeEnvelopeSecrets` (`apps/api/src/edge/envelope-secrets.ts`) menghapus `payload.material` sebelum event disimpan sebagai konflik (`db-link-store.ts`), saat diparkir (`deferred-event-applier.ts`), dan saat drain menandai baris.
   - `enqueueEdgeEvent` menolak `staff_pin.set` yang membawa `material` di arah selain edge→cloud.
   - Error DB saat menulis `staff_pins` dilempar ulang sebagai error generik, supaya hash tidak masuk log.
3. Urutan PIN:
   - Kolom baru `staff_pins.pin_set_at`. Set dari edge diterapkan hanya bila `setAt > pin_set_at`; bila sama, cloud tetap.
   - Disimpan `LEAST(setAt, now())`, dengan `updated_at = clock_timestamp()` supaya diekspor ulang ke edge.
   - Baris dicocokkan per (tenant, outlet, user), dan id cloud dipertahankan. Bila id edge sudah dipakai tenant lain, dibuat id baru.
4. `staff_pin.locked`:
   - Diterapkan hanya bila `occurredAt > pin_set_at` dan lock masih aktif.
   - `failedAttempts = MAX`, dan `lockedUntil = GREATEST(existing, LEAST(event, now() + STAFF_PIN_LOCK_MINUTES))`.
5. Override:
   - Hanya audit, dengan bentuk sama seperti `recordApprovedOverride`.
   - Payload mendapat `reason` dan `reasonCode` opsional.
   - Ditolak bila `requestedBy == approvedBy`.
   - Dedupe lewat `overrideId` di `audit_logs`, dibatasi `created_at >= LEAST(occurredAt, now()) - 1 day`.
6. Replay baris parkir:
   - Kolom baru `edge_deferred_events.applied_at` dan `apply_outcome` (applied, not_applicable, refused), dengan index parsial.
   - Drain lazy (maks 25, `FOR UPDATE SKIP LOCKED`) di dalam applier akses sebelum event live diproses. Tiap baris punya savepoint sendiri; error apa pun menandai baris `refused`, dan log hanya berisi jumlah dan kelas error.
   - Baris v1 tanpa `material` menjadi `not_applicable`.
7. Sequence (review F1):
   - Aggregate `staff_pin` dan `pos_override` di arah edge→cloud menerima sequence apa pun (`registerEdgeAggregateLastSequence`).
   - Dengan begitu, satu event yang ditolak atau standby yang mengambil alih tidak mengubah event berikutnya menjadi `sequence_gap`.
   - Dedupe per event id (`edge_received_events`) tetap berjalan lebih dulu.
8. Edge (review F2): di `applyStaffPinRecords`, record cloud dengan material yang sama digabung `GREATEST` untuk lock dan attempts, sehingga tidak pernah membuka lock edge.
9. Isolasi:
   - `assertEdgeEventScope` memeriksa arah, tenant, outlet dalam scope, dan outlet node.
   - Aggregate id harus cocok dengan payload. User harus punya role di tenant, dan target PIN tidak boleh dibanned.
   - `pepperVersion` yang berbeda dilewati.
10. `runtime.ts`: hanya `registerAccessEdgeApplier()` yang menggantikan `registerAccessDeferredEdgeApplier()`. File `app.ts`, `routes/index.ts` dan `worker-main.ts` tidak disentuh.

## Invarian

- Idempoten per event id, baik untuk live (`edge_received_events`) maupun replay (`applied_at`). Audit override tidak pernah dobel.
- Set PIN yang lebih lama tidak pernah menimpa yang lebih baru; bila sama, cloud menang. Lock tidak pernah diperpendek.
- Tenant, outlet dan node terisolasi.
- Drain tidak pernah menahan batch.
- Hash dan salt tidak pernah tersimpan di luar `staff_pins`: tidak di konflik, baris parkir, outbox menuju perangkat, maupun log.
- Cloud tidak memancarkan event saat menerapkan; tidak ada ping-pong.

## Review K

- Putaran 1, reviewer Opus:
  - F1: sequence gap menghilangkan set PIN (medium).
  - F2: lock edge terbuka sesaat (medium, keamanan).
  - F3: drain diam selamanya (low).
  - F4: hash di teks error (low).
  - Semua DIPERBAIKI; F1 dan F2 punya test.
- Putaran 1, architect:
  - Bentrok nomor migrasi (high): diserahkan ke merge train.
  - F5: `updated_at = now()` memakai waktu awal batch, sehingga ekspor bisa terlewat (medium).
  - F6: scan audit tanpa batas (medium).
  - F7: drain tidak meredaksi baris parkir lama (medium).
  - F8: bentrok primary key global `staff_pins.id` (low).
  - Semua DIPERBAIKI.
- Putaran 2 (keduanya): tidak ada blocker atau medium. Sisa yang diterima:
  - Clamp `LEAST` pada jendela dedupe audit: DIPERBAIKI.
  - Komentar F2 dan komentar drain: DIPERBAIKI.
  - Error DB sementara menandai baris parkir `refused` permanen: DITERIMA, demi mencegah drain macet; envelope tetap tersimpan.
  - `staff_pin.set` menghapus lock cloud bila urutan antar node berbeda: DITERIMA, karena edge mempertahankan lock (F2).
  - PIN yang benar dimasukkan di cloud tidak mengosongkan counter edge: DITERIMA, karena tidak pernah melemahkan.

## Risiko untuk second opinion

- Urutan deploy: cloud harus lebih dulu dari edge. Cloud lama akan memarkir atau menyimpan konflik `staff_pin.set` dengan hash tanpa redaksi.
- Jam edge yang tertinggal membuat set PIN edge yang lebih baru kalah (bead legend-t9ii).
- Set PIN v1 dari sebelum rilis tidak bisa dipulihkan cloud (bead legend-zclb).
- Drain lazy hanya per outlet yang masih mengirim event akses (bead legend-0q3r).
- F1 melonggarkan cek sequence untuk dua aggregate. Benarkah semua applier aman dijalankan dua kali dan bebas urutan?
- Keanggotaan tenant memakai role assignment apa pun, termasuk yang sudah `validUntil` lewat. Verifikasi PIN tetap menghitung izin saat verify.

## Putaran Codex 160 (dua P2), di atas 09658266 sampai `19087b75`

- Rentang: `git diff 09658266..19087b75`. Migrasi baru `apps/api/drizzle/0135_steep_quasimodo.sql` (nomor juga perlu diurutkan ulang di merge train, bersama 0134).
- P2(1) urutan generasi PIN:
  - Kolom baru `staff_pins.pin_generation_at` (NOT NULL, default now(), backfill dari `pin_set_at`). Set dan lock diurutkan dengan kolom ini memakai `setAt`/`occurredAt` mentah dari edge. `pin_set_at` tetap nilai yang dibatasi `LEAST(setAt, now())`.
  - `setStaffPin`: kunci tidak pernah mundur, di cloud dan di edge (`GREATEST(stamp, kunci lama + 1 ms)`). Edge mengirim kunci tersimpan itu sebagai `material.setAt`.
  - Batas jam: set dengan `setAt` lebih dari 5 menit di depan jam cloud ditolak `VALIDATION_ERROR` (menjadi konflik yang terlihat). Lock dengan `occurredAt` lebih dari 5 menit di depan diabaikan. Tanpa batas ini, satu edge dengan jam tahun 2100 membekukan PIN.
- P2(2) galat tulis berisi material:
  - Helper `withoutSecretErrorDetail` (`envelope-secrets.ts`): `CoreError` diteruskan, galat lain diganti Error generik tanpa `cause`.
  - Dipakai di tulisan outbox `staff_pin.set` (`device-pin.service.ts`), insert antrean edge yang membawa material (`edge-queue.service.ts`), tulisan `staff_pins` di `setStaffPin`, dan dua tulisan hash di `staff-pin-sync.ts`.
- Test (`edge-access-applier.test.ts`, `device-pin-service.test.ts`): A lalu B dalam satu batch dengan jam edge +5 detik (B menang); dua set masa depan +2 dan +3 menit; set cloud sesudah set edge masa depan; set +1 jam ditolak lalu set normal diterapkan; lock di antara `pin_set_at` dan generation diabaikan; lock +5 menit lebih diabaikan; kunci edge tetap monoton setelah jam mundur; sentinel trigger untuk outbox, antrean edge, dan tulisan `staff_pins` (tidak ada hash atau salt di message, stack, cause, JSON).
- Review K:
  - Reviewer Opus: batas masa depan tidak ada (medium), skew jam antar node (medium), tulisan `staff_pins` belum dibungkus (low), test lock dan skew kurang (low). Semua DIPERBAIKI kecuali skew antar node: jendelanya kini maksimal 5 menit, sisa diterima dan diserahkan ke legend-t9ii (versi urut commit).
  - Architect: batas masa depan (medium) dan kunci edge tidak monoton (medium): DIPERBAIKI. Set edge yang ditolak tidak diekspor ulang ke edge (low): bead legend-kgbw. Migrasi dan cakupan C2: tidak ada temuan.
- Re-review: kunci edge yang tertinggal lebih dari 5 menit di depan menempel setelah NTP (medium): DIPERBAIKI, kunci lama dibatasi `stamp + 5 menit` di cabang edge, dengan test jalur nyata.
- Gate: tsc, eslint, prettier, 31 file 450 test.
- Yang perlu dilihat second opinion: batas 5 menit cukup atau terlalu ketat untuk outlet dengan NTP buruk; sisa skew antar node di bawah 5 menit.
