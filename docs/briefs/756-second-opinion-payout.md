# Brief: second-opinion (Codex, xhigh) — area payout sebelum batch 64c

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan bagian "Kuota Codex dan second opinion" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Baca saja; tidak mengedit kode.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis pembanding: `origin/milestone/m1`.

## Tujuan
Satu second opinion untuk area payout gaji (uang) atas gabungan cabang yang akan masuk batch 64c:
- `origin/ws/payout-api-gaps` (adde2aebe, migrasi 0600)
- `origin/ws/payout-evidence-hardening` (2633c2195)
- `origin/ws/payout-followups` (6574cb40f, migrasi 0608: tarik usulan langkah-1; tunai tanpa evidenceKey)
- `origin/ui/payout-wiring` (f47c6536c: rekening dari snapshot batch, unggah bukti, usulan langkah-1 ke penyetuju kedua)
- `origin/ui/payout-finance-exceptions` (fd7cc56cd), `origin/fix/finance-exceptions-known-count` (5bfbcf4b2), `origin/fix/payroll-policies-hydration` (7b3fb65b7)
Cara termudah: buat worktree sementara dari m1, `git merge --no-commit` cabang-cabang itu berurutan (atau baca `git diff origin/milestone/m1...<cabang>` per cabang), hapus worktree setelah selesai.

## Yang dicari (aturan founder: jangan sampai rugi)
- Jalan apa pun yang membuat karyawan dibayar dua kali atau lebih dari slip, atau slip dilepas tanpa dua orang + bukti.
- Pemisahan tugas: peminta batch, pengusul langkah-1, penyetuju langkah-2; tarik usulan; tenant lain.
- Bukti: tipe file, pemindai (gambar boleh tanpa pemindai nyata karena di-encode ulang sharp; PDF 503 — keputusan CTO), signed URL, kebocoran rekening (harus tersamar `****1234`).
- Trigger PAYOUT-18 dan migrasi 0600/0608 (nomor jurnal akan dinomori ulang di merge train; nilai yang diperiksa adalah isinya).
- Race dan idempotensi pada resolve, withdraw, return.
- UI yang mengirim data berbeda dari yang disetujui (mis. langkah-2 memakai bukti yang sama).

Keputusan yang sudah diambil (jangan dilaporkan sebagai temuan): bukti JPEG/PNG saja di rilis pertama; unggah bukti akan memakai kebijakan step-up yang sama dengan resolve (legend-dz8g3); nama pengusul, tombol batal batch, polish UI sudah jadi kartu (legend-eszso, legend-ctuia, legend-oggiw).

## Laporan
Daftar temuan, diurutkan dari yang paling berat: file:baris, skenario gagal konkret, dampak uang, saran perbaikan. Pisahkan "nyata" vs "mungkin". Bila tidak ada temuan, katakan begitu, beserta apa yang diperiksa. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
