# 188b: second opinion, penarik PIN cloud ke edge dan adopsi set PIN edge

Tingkat K (PIN staf: hash rahasia, auth offline, sinkron offline, migrasi). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang diff

Cabang `ws/edge-pin-pull`, di-rebase ke m1 `12c91f6b` (edge-pin-sync sudah di m1, migrasinya 0151). Rentang: `git diff 12c91f6b e32874a6` (commit 3f8530c0 skema + migrasi `0153_staff_pin_pull` when 1794232000000, f394a301 fitur, e22cad33 perbaikan review K, 54c63ae9 test, e32874a6 nomor migrasi di komentar/runbook). Sebelum rebase: `e420469e..40486d5b`.

## Kartu

- legend-yvhw8: penarik `staff-pin-records` dipasang di runtime edge (primary dan standby).
- legend-kgbw: set PIN edge yang ditolak cloud membuat baris cloud diekspor ulang, sehingga edge mengganti PIN yang ditolak.
- legend-rucdm: set PIN edge berikutnya dari node yang sama (urutan outbox lebih tinggi) diadopsi cloud walau jam edge mundur.
- legend-7vv8h: resync penuh tidak mengembalikan counter atau lock yang sudah dibersihkan edge.
- legend-4z2ch: runbook (timeout transaksi idle, alert horizon ekspor).

## Berkas berisiko

- `apps/api/src/edge/staff-pin-pull.ts`, `apps/api/src/edge/cloud-http.ts`, `apps/api/src/edge/runtime.ts`
- `apps/api/src/services/edge-device-sync-store.ts`
- `apps/api/src/edge/access-applier.ts` (`applyStaffPinSet`)
- `apps/api/src/services/device-pin.service.ts`, `apps/api/src/services/staff-pin-sync.ts`
- Migrasi `0153_staff_pin_pull`
- `docs/deployment.md` (runbook)

## Invariant

- Set PIN yang lebih lama tidak pernah menimpa yang lebih baru; set berikut dari node yang sama selalu lebih baru dari set sebelumnya node itu; set cloud dan node lain dibandingkan dengan kunci generasi, bila sama cloud menang.
- Cloud tidak mengadopsi material yang sama dua kali; replay tidak membuka lock.
- PIN edge yang ditolak cloud diganti nilai cloud setelah tarikan berikut.
- Resync penuh (epoch berubah) idempoten: tidak mengembalikan counter atau lock yang sudah dibersihkan edge, tetapi kegagalan baru di cloud tetap sampai.
- Watermark disimpan hanya setelah semua halaman diterapkan; cursor yang ditolak cloud mulai ulang dari awal.
- Hash dan salt tidak pernah masuk log, error, konflik, atau baris parkir.
- Apply cloud dan edge tidak memancarkan event; tidak ada ping-pong.

## Pertanyaan untuk second opinion

- Aturan adopsi per node (`generation_edge_node_id` + sequence agregat) vs guard urutan: apakah ada jalur di mana set lama menang, atau set baru node yang sah ditolak permanen (node dibangun ulang dengan id sama, lihat runbook langkah 5)?
- Sentuhan re-ekspor legend-kgbw: beban dan kemungkinan loop.
- Baseline legend-7vv8h ("berbeda dari baseline"): kegagalan cloud yang hilang atau lock yang melemah.
- Sisa yang diketahui: legend-li03g (edge sempat memakai PIN lama satu interval pull bila E1 kembali sebelum cloud menerapkan E2).
