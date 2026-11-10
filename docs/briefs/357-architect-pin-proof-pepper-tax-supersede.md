# Brief: architect — bukti PIN absen edge, pepper PIN di edge, supersede laporan pajak

## Peran
Baca `~/.agents/team/roles/architect.md` dan hanya bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tidak mengubah kode.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis baca: cabang `ws/j6cyb-edge-attendance` (d0376c66) untuk keputusan 1-2, `ws/gmww-accounting-deltas` (dd4db5d2) untuk keputusan 3. Tulis di worktree sendiri: `git worktree add .worktrees/arch-357 -b ws/arch-357-decisions milestone/m1`.

## Tujuan
Tiga keputusan teknis, masing-masing satu entri di `docs/DECISIONS.md` (opsi, pilihan, alasan, dampak migrasi/kontrak, kartu bd lanjutan dengan kriteria terima):
1. **Bukti PIN untuk absen di edge** (temuan tinggi review j6cyb, blok `legend-tvkuz` C8): clock `outlet_device` di edge tidak memeriksa PIN staf; orang yang absen = pemilik cookie sesi POS. Pilih: bukti PIN berumur pendek terikat device+user, atau sesi PIN per clock. Sertakan: TTL, replay, rate limit, MFA (`mfa_required` peran outlet), header `X-Device-Token` di CORS `app.ts`.
2. **`legend-ideif`**: edge menyimpan root `STAFF_PIN_PEPPER`; edge dicuri melemahkan PIN semua tenant. Desain turunan pepper per tenant/outlet yang bisa dipakai keputusan 1, plus jalur rotasi dan migrasi hash PIN lama.
3. **`legend-4uapw`**: supersede vs pembetulan SPT untuk `tax_reports` (beberapa laporan final per periode). Hasilnya jadi dasar `legend-5nhkp` (service + routes tax report).

## Masukan
- `bd show legend-tvkuz legend-ideif legend-4uapw legend-5nhkp`.
- `docs/design/hris-edge-replication.md` (cabang `ws/hris-edge-design`) §2.
- `apps/api/src/edge/mode.ts`, rute `/api/staff-pins/verify`, `packages/shared/src/accounting/tax.ts`.
- Founder sudah putuskan Q86: absen outlet = PIN + selfie.

## Scope
- Boleh diubah: `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACT.md` (bagian terkait saja), kartu bd baru.
- Jangan disentuh: kode di `apps/`, `packages/`, migrasi.
- Nomor migrasi yang boleh dipakai kartu lanjutan: 0241-0244 (catat di kartu).

## Bukti selesai
- Tiga entri DECISIONS.md, commit di `ws/arch-357-decisions`, push ke origin.
- `bd comment` di tvkuz, ideif, 4uapw dengan ringkasan keputusan; kartu lanjutan dibuat.

## Laporan
Ringkas per keputusan: pilihan + alasan satu kalimat, kartu baru (id), apa yang perlu founder putuskan (hanya bila berdampak bisnis), SHA.
