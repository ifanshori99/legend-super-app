# Catatan rilis: PPh 21 Desember, skema `gross_first` (legend-y2lf)

Status: menunggu cek konsultan pajak. Jangan dirilis sebelum rumus ini dicek.

## Yang berubah

Pada masa pajak terakhir (Desember) dengan kebijakan `gross_first`, bagian pajak
yang ditanggung karyawan sekarang dihitung dari gaji skema gross saja:

- Lama: annual(P + G*) - annual(P), P = seluruh pendapatan Jan-Nov.
- Baru: annual(Gs + G*) - annual(Gs), Gs = bagian skema gross Jan-Nov, G* = gaji
  skema gross Desember, dibatasi (cap) D = tambahan pajak bulan itu.

Alasan: saldo karyawan Jan-Nov sudah memakai annual(Gs) - dibayar. Bagian
Desember harus memakai skala yang sama. Dengan rumus lama, karyawan bisa membayar
lebih dari pajak gross-nya sendiri (contoh H7: gross 60 jt setahun, pajak sendiri
150.000, mesin membebani 237.500; sekarang total beban karyawan 150.000).

Rumus baru hanya dipakai bila skema Jan-Nov diketahui (`lastTaxPeriod` dan
`priorMix > 0`). Bila tidak (priorMix = 0) perilaku lama dipertahankan, karena
Gs tidak bisa diketahui. Jalur `proportional`, TER, dan penyelesaian saldo
karyawan/perusahaan tidak berubah.

## WAJIB dicek konsultan pajak sebelum rilis

1. Rumus annual(Gs + G*) - annual(Gs) memakai PTKP dan biaya jabatan pada gaji
   gross saja. Karyawan yang gaji gross-nya di bawah PTKP (misal sebagian besar
   penghasilannya gross-up atau net) menanggung Rp 0, dan perusahaan menanggung
   seluruh pajak Desember (contoh: N1, gross-up 15 jt Jan-Nov, Desember gross 15
   jt: karyawan 0, perusahaan menanggung 1.698.198; sebelumnya karyawan 2.250.000).
2. Apakah pemisahan beban karyawan dan perusahaan ini sesuai ketentuan (PMK
   168/2023 Pasal 15 dan 21) dan kebijakan perusahaan, atau perlu pendekatan lain.
3. Pajak yang ditanggung perusahaan ikut menjadi bruto, jadi pajak tahunan akhir
   bisa naik sedikit (H7: 3.487.350 menjadi 3.502.800) karena bagian perusahaan
   lebih besar. Cek apakah ini wajar.

## Angka lama yang berubah (hanya `gross_first`)

H1, H3, H4, H7 (history-split-reference), C1-C6 dan N1 (unclamped-reference),
O1, O5, O6 (overwithhold-reference), S2 (takehome-cap). Angka baru dihitung
tangan terpisah dari mesin dan dicatat di komentar tiap test.
