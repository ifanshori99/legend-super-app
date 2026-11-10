# Brief Codex second-opinion: open bill oleh supervisor + kebijakan outlet (tingkat K: auth, uang)

Repo: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/open-bill-r1`, cabang `ws/open-bill-r1` (dari `milestone/m1` `fee69d45`). Kartu `legend-8cm4`, `legend-2zb5`. Baca saja; jangan commit/push.

## Yang ditinjau
`git diff fee69d45..HEAD` (dan perubahan belum di-commit bila ada). Keputusan dan aturan: `docs/briefs/sub-open-bill-step2.md` bagian "Keputusan (final)".

Inti:
- `POST /api/table-sessions/:sessionId/open-bill`: staf (`floor.table.operate`) meminta, penyetuju (`floor.session.open_bill`) memasukkan PIN; sesi `pay_first` berjalan menjadi `open_bill` bila exposure < `maxBillValueIdr`. Audit `open_bill.session_converted`.
- `GET/PUT /api/outlets/:outletId/open-bill-policy`, `GET /api/outlets/:outletId/open-bill/approvers`.
- Sweep `service_request.overdue` memakai `billRequestSloSeconds` kebijakan outlet untuk `request_bill`.
- Permission baru di `packages/shared/src/access/{permissions,roles}.ts`.

## Pertanyaan yang harus dijawab
1. Bisakah peminta tanpa hak menjadikan meja open bill (permission penyetuju dicek di outlet yang benar? approverUserId dari tenant/outlet lain? PIN dihitung sebelum cek hak?).
2. Brute force PIN: apakah percobaan dihitung dan dikunci sama seperti override; apakah daftar approvers membocorkan sesuatu yang tidak perlu.
3. Race: dua konversi bersamaan, konversi bersamaan dengan pembayaran/penutupan/pindah meja/pesanan baru; exposure dihitung di bawah kunci yang sama dengan `assertOpenBillWithinLimit`?
4. Isolasi tenant/outlet di semua route baru (RLS `withTenant`, filter outlet).
5. Kebijakan: batas validasi, siapa yang bisa PUT, audit; sweep SLO tidak N+1, tidak memengaruhi tipe permintaan lain atau tenant lain.
6. Data pribadi: PIN/alasan tidak masuk log; audit tidak berisi PIN.

## Laporan
Temuan nyata saja, `file:line`, tingkat (High/Medium/Low), skenario gagal konkret, usulan perbaikan. Tulis ke `docs/briefs/180b-second-opinion-open-bill.result.md`.
