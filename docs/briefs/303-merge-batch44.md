# Merge train batch44

Basis: ref `milestone/m1` 8c30c356 (batch43). Prosedur sama dengan brief 296: `--no-ff`, rechain migrasi, `db:generate` kosong sesudah tiap merge bermigrasi, gate lewat `heavy` (typecheck, `pnpm test` penuh, e2e), reviewer untuk hunk konflik + rantai migrasi, lalu majukan ref m1.

## Urutan merge (urut `when`; `when` harus naik ketat sesuai urutan merge)
1. `ws/tax-snapshot-facility` 09a124b2
2. `ws/brand-logo-upload` 52f4242a — 0201, 1794280000000
3. `ws/split-bill` c6916247 — 0202, 1794281000000 (prevId lama 0186: rechain)
4. `ws/ws08-111j` e15950fe — 0203, 1794282000000. Deploy 0203 di jendela sepi (ACCESS EXCLUSIVE pada `orders`): tulis di catatan rilis.
5. `ws/purchase-return-posting` 58d79c20 — 0205, 1794284000000
6. `ws/hr-scheduling` 88cc626e — migrasi 0199 lama: `when` 1794278000000 sudah di bawah 0200 yang terpasang, jadi beri nomor dan `when` baru di antara 0205 dan 0206 (mis. 1794284500000), rechain.
7. `ws/hr-lifecycle-kpi` 5f864932 — 0206, 1794285000000 (dibangun di atas hr-scheduling)
8. `ws/m4p5-rewards` 911846ad — 0207, 1794286000000 (berisi 111j)
9. `ws/supplier-return-petty` f2bd63f5 — 0208, 1794287000000 (berisi purchase-return-posting)

Nomor 0209-0212 dipesan untuk cabang yang belum selesai; jangan dipakai.

## Catatan
- Flag `PURCHASE_RETURN_POSTING_ENABLED` default mati; jangan dinyalakan.
- Konflik kode (bukan docs/journal/index export): berhenti dan lapor ke CTO dengan nama cabang dan berkas.
- Sesudah gate: hapus worktree yang cabangnya sudah di m1 dan bersih (tanpa `--force`): `hr-scheduling`, `split-bill`, `ws08-111j`, `purchase-return-posting`, `hr-lifecycle-kpi`, `m4p5-rewards`, dan worktree tax-snapshot/brand-logo bila ada. Jangan hapus `small-293` atau worktree lain yang sedang dipakai thread.
- Daftar berkas untuk alat: tulis ke berkas sementara lalu `xargs`, jangan ekspansi array zsh di satu baris.

## Laporan
Sekali di akhir: SHA m1 baru, tabel migrasi (`when`, prevId), konflik, angka gate, temuan reviewer, perbaikan isi di luar konflik, worktree dihapus, ruang disk.
