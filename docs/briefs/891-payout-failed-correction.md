# 891 Payout: koreksi resolusi failed -> succeeded

Kartu: `legend-mejr2`. Tingkat K uang + migrasi. Thread yang sama dengan 888 (konteks sudah ada).

## Keputusan CTO (opsi B, jangan ditanyakan ulang)
Opsi A memaksa operator membayar karyawan dua kali agar buku cocok, melanggar aturan founder "jangan sampai rugi". Bangun jalur koreksi tanpa pembayaran baru.

## Aturan
- Cabang baru `fix/payout-failed-correction-891` dari `fix/payout-area-final-888` (bddf9bf6c). Migrasi nomor sementara 0635-0637.
- Hanya item `failed` yang resolusinya sudah final (dua orang) dan BELUM punya pembayaran susulan yang berhasil (retry sukses, overpaid, atau item pengganti di batch lain). Ada pembayaran susulan: tolak 409, pakai jalur overpaid.
- Dua orang berbeda (pengusul ≠ penyetuju, dan penyetuju ≠ pembuat resolusi failed), permission `payroll.disburse.approve`, `stepUp` + `passwordStepUp`, bukti bank (hash byte, diikat ke satu koreksi, dikonsumsi atomik, tidak bisa dipakai di item/tenant lain).
- Guard DB: transisi `failed -> succeeded` hanya lewat baris koreksi yang disetujui; jurnal settle tepat sekali (debit utang gaji beku dari 0632, kredit akun sumber yang dipakai saat ekspor), idempoten, nominal = nominal item.
- Accounting mati atau jurnal lock belum ada: ikuti pola settle tertunda yang sudah ada, bukan skip final.
- Item yang sudah dikoreksi tidak bisa lagi dibuat retry/batch susulan (tolak 409), supaya tidak ada transfer kedua.

## Daftar periksa invarian (Retro 32/33)
Cek ulang status dan bukti di dalam kunci; balapan koreksi vs retry paralel (satu menang); jumlah uang keluar per item ≤ nominal item; GL seimbang dan cocok dengan uang bergerak; test pasangan (registry migrasi, guard trigger, sweep) diperbarui; seluruh test terarah payout/GL hijau.

## Bukti selesai
- Test merah dulu di 888, lalu hijau: koreksi sukses (satu jurnal, item succeeded, utang gaji tertutup), ditolak bila ada pembayaran susulan, pembuat sendiri ditolak, bukti dipakai ulang ditolak, koreksi lalu retry ditolak, dua koreksi paralel hanya satu.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat heavy, `db:generate` kosong).
- Satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Push tanpa force. Lapor SHA, migrasi, test merah→hijau, angka subagent. Jangan merge, jangan deploy. Web untuk jalur ini: catat kartu lanjutan, jangan dikerjakan.
