# 1003 Mockup: layar flag recon payout dan clearance 2 orang (legend-o2b4m)

Peran: designer (baca ~/.agents/team/roles/designer.md dan ~/.agents/team/ui-standard.md). Codex gpt-6.1-sol, effort high.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (bila tersedia; Codex maks 6).

Tujuan: mockup HTML statis untuk tim finance di backoffice. Ikuti pola mockup yang ada: `design/mockups/backoffice/account-role-mappings.html` + `account-role-mappings-render.mjs` (6 keadaan: normal, empty, loading, error, validation, success; desktop 1280 dan mobile 390). Tulis ke `design/mockups/backoffice/payout-recon-clearance.html` + render script + PNG.

Isi layar (API sudah ada di cabang `ghostex/92055877` 74e142d8b; baca `git show 74e142d8b:apps/api/src/routes/<payout recon routes>` dan validator shared untuk nama field, jangan menebak):
- Daftar flag recon per batch payout: alasan flag dalam bahasa finance (mis. "Biaya transfer tidak cocok dengan nilai terkunci", "Bukti penutupan tanpa tanda tangan"), item/karyawan, nominal, status (terbuka, diusulkan, disetujui, terbuka ulang), slip yang tertahan.
- Usul clearance: alasan wajib, konfirmasi kata sandi.
- Setujui clearance: hanya orang lain selain pengusul; tampilkan siapa mengusulkan dan kapan; tombol nonaktif + penjelasan untuk pengusul sendiri.
- Data berubah setelah usulan (PAYOUT_RECON_FLAG_CHANGED): pesan jelas, ajakan membuat usulan baru.
- Terbuka ulang: tanda bahwa clearance lama tidak berlaku karena data berubah.
Teks UI Bahasa Indonesia, angka Rupiah format Indonesia.

Hasil untuk gerbang founder: ringkas 3-5 baris apa yang dilihat founder dan pilihan desain yang perlu diputuskan (bila ada). Jangan sentuh kode aplikasi. Commit hanya berkas mockup di cabang worktree-mu, push tanpa force. Lapor sekali di akhir: path HTML/PNG, keputusan desain, pertanyaan untuk founder.
