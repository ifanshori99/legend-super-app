# sub-539-u2 review page (Ghostex page for the founder)

Output: `docs/review/539-u2-kasir-tambahan.html` in worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-extra`. Only that file. No commit, no `ghostex show`.

Read first: `~/.agents/skills/ghostex-visuals/SKILL.md` sections "No page chrome of your own", "Theme", "Images, sandbox, publishing", "Ghostex pages with questions"; example `~/.agents/skills/ghostex-visuals/examples/plan-review.html` (marker `<meta name="ghostex-page" content="v2">`, `<gx-questions submit="Kirim ke tim">`).

Reader: founder, non-technical, Indonesian. Plain Indonesian, short sentences, no code words (no "endpoint", "schema", "idempotency"). Title 2-4 words, e.g. "Review kasir tambahan".

Images: absolute paths `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-extra/design/screenshots/pos-u2/<state>-light-1280.png` and `-light-390.png` (they are re-rendered later under the same names; never use `*.error.png`). Each group: one `<figure class="gx-figure">` with the 1280 shot, and one with the 390 shot (side by side in a `gx-grid` or `gx-options`-free grid), figcaption in Indonesian. Keep total images ≤ 22.

Header chips: `11` kartu, `9` kelompok layar, `91` test logika uang lulus, mode contoh (data contoh, belum tersambung server).

One group = one `<h2>` + 1-2 sentence explanation of what the screen does for the outlet + figures + one `<gx-question>` directly under it with two choices: `<gx-choice value="setuju" recommended>Setuju<small>...</small></gx-choice>` and `<gx-choice value="ubah">Perlu diubah<small>Tulis apa yang perlu diubah di catatan.</small></gx-choice>`. Tag = card ids. Groups (state names for images):

1. Koreksi pesanan: diskon, void, refund, struk (legend-2fo) — `koreksi-void-sebelum`, `koreksi-struk` (390: `koreksi-void-sebelum`). Note: diskon diisi dalam persen (sistem menghitung rupiahnya).
2. Rincian pesanan + pemberitahuan void dari dapur (legend-0ixe) — `pesanan-kosong` 1280, `pesanan-gagal` 390.
3. Tagih selisih ke pelanggan (legend-shabi) — `tagih-selisih-normal`, `tagih-selisih-belum-pasti` (390).
4. QRIS di layar pelanggan (legend-5w6) — `display-normal`, `display-success` (390).
5. DP menutup seluruh tagihan (legend-p7lx, perbaikan bug uang) — `bayar-dp-lunas`.
6. Shift: kas keluar tertahan, hitung kas, tutup paksa (legend-pspy, legend-7mlf) — `supervisor-kas-ditahan`, `supervisor-tutup-paksa-siap` (390), `shift-hitungan-batas` optional.
7. Tindak lanjut refund: tolak, coba lagi, karantina (legend-kfkt, legend-hn5q) — `refund-karantina`, `refund-unknown` (390). Note: dibuat sebagai jendela di halaman Pembayaran, bukan halaman terpisah seperti mockup; filter "Karantina" di daftar refund.
8. Selisih tutup shift di kotak persetujuan (legend-6om3) — `persetujuan-normal`. Note: hanya penyetuju yang melihat angka selisih; angka tanpa tanda plus/minus karena sistem belum mengirim arahnya.
9. E-struk untuk pelanggan (legend-1uk9) — `struk-publik-normal` (390 only + 1280).

After the groups, one `<h2>Keputusan yang perlu Anda ambil</h2>` with `<div class="gx-callout" data-tone="warn">` per decision and a question each:

- Q-QRIS (uang): Layar pelanggan saat ini selalu menampilkan QRIS sebesar total tagihan, belum dikurangi DP. Untuk pesanan dengan DP, pelanggan bisa diminta membayar lebih. Pilihan: "Tahan QRIS di layar pelanggan untuk pesanan ber-DP sampai server diperbaiki" (recommended, membatasi pembayaran) / "Perbaiki server dulu sebelum layar ini dipakai" / both are safe; first is recommended.
- Q-REFUND-FORM: Mockup menampilkan tiap keadaan refund sebagai halaman penuh; yang dibangun adalah jendela di halaman Pembayaran (lebih cepat, sama isinya). Pilihan: "Jendela sudah cukup" (recommended) / "Ikuti mockup: halaman penuh".

End: `<p>` small note: screens use contoh data; menyambung ke server butuh kartu backend yang tim catat.

Then run `ghostex visual check docs/review/539-u2-kasir-tambahan.html --out /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/7a50c949-91cb-4478-8fbe-e0605817ecac/scratchpad/review-page.png` and fix every error/warning it lists (look at the PNGs). Report ≤8 lines: path, image count, page size, check result.
