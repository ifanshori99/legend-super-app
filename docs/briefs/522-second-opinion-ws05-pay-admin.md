# 522 Second-opinion Codex: admin pembayaran + refund (ws/ws05-pay-admin)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). READ-ONLY. Repo: /Users/ifanshori99/Projects/legend super app/legend. Diff: `git diff origin/milestone/m1...origin/ws/ws05-pay-admin` (abaikan snapshot drizzle JSON). Juga baca jalur refund/approval/unallocated yang sudah ada di m1 yang disentuh diff.
Invariant founder: tidak ada pihak dibayar lebih, outlet tidak rugi. Fokus: refund paralel/retry gateway melebihi bayar, dana belum teralokasi teralokasi dua kali, maker != checker, idempotency (replay vs body beda), default kasir ke terminal/metode nonaktif, migrasi 0328 (partial unique, data lama), mock vs API.
Laporan: temuan P0-P3 dengan file:baris, skenario gagal konkret, usulan fix. Tanpa temuan: tulis jelas.
