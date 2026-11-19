# Second opinion 1157: kas ronde 11

Hasil: **Tidak ada temuan tambahan P0–P3 yang terbukti dalam scope brief. P1 ronde 10 tertutup secara statis.**

## Basis pemeriksaan

- `git fetch origin` berhasil; head review tepat `14e34d88798c42fb172af6f09a593598d570e852` pada `origin/ghostex/d158b041`.
- Rentang utama: `f1f0c49870b0ac320ef93fb76b9340a5290a0cba..14e34d88798c42fb172af6f09a593598d570e852`, dengan snapshot migrasi dikecualikan sesuai brief. Konteks tambahan memakai `origin/milestone/m1...14e34d88798c42fb172af6f09a593598d570e852`; nomor baris di bawah merujuk head review.
- Tiga subagent paralel memeriksa mapping dan jalur penulisnya; kas, cadangan, dan reversal; serta preflight SQL dan isolasi tenant/entity. Agent utama memeriksa silang kesimpulan dengan kode head dan laporan ronde 10.
- Risiko yang sudah diterima CTO dalam brief 1157 dan brief pendahulunya tidak dilaporkan ulang sebagai temuan baru.

## Penutupan ronde 10

- `apps/api/src/services/accounting-journal.service.ts:1130`: Guard mengambil akun petty cash dari snapshot sekaligus mapping sekarang. Pada `:1157`, net kredit dinilai per akun, sehingga debit pada akun lain tidak meniadakan kredit historis. Untuk skenario legacy bank B menjadi petty cash, kredit B mencapai pemeriksaan sumber; posting gaji `settle` tetap terkunci oleh `:1228` dan menghasilkan 409 `CASH_OUT_JOURNAL_LOCKED` di `:1247`. Pembayaran supplier `paid` juga tetap terkunci melalui `:1241`.
- `apps/api/src/services/accounting-accounts.service.ts:325`: Jalur PUT menolak perubahan role kas ke akun berjurnal sebelum mapping ditulis. Helper `accounting-cash-mapping-history.ts:40` membandingkan mapping lama dan calon mapping; `:48` memeriksa keberadaan baris jurnal, bukan saldo netonya. Karena itu skenario bank direverse dahulu lalu dipetakan menjadi petty cash juga tertutup: baris jurnal asal dan reversal tetap merupakan riwayat.
- `apps/api/src/services/tenant-config-finance.ts:593`: Impor memakai helper riwayat yang sama sebelum insert. Penolakan `ConfigImportError` berada dalam transaksi impor; status 422 dan rollback tanpa tulis sebagian sesuai keputusan CTO.
- Test pada `apps/api/src/test/cash-1147-bank-reversal-remap.test.ts:370` memuat skenario gaji bank legacy, penolakan reversal, saldo tetap nol, dan kasbon berikutnya ditolak; `:426` memuat reimburse dan `:756` pembayaran supplier. Test mapping berada di `cash-1147-mapping-history.test.ts:251` dan `:424`. Ini pemeriksaan isi test, bukan klaim bahwa test dijalankan pada sesi ini.

## Pemeriksaan jalur terkait

- `apps/api/src/services/accounting-petty-cash.service.ts:755`: Cadangan delivered kasbon/reimburse tetap menilai akun snapshot; penghitungan net kredit di `:759` turut menghitung reversal. Kas tersedia tetap dihitung sebagai GL dikurangi cadangan pada `:853`. Tidak ditemukan rantai tambahan yang terbukti melepas cadangan tanpa kas berkurang dalam perubahan yang diperiksa.
- `apps/api/src/services/accounting-provisioning.service.ts:248`: Provisioning chart yang sudah ada hanya menambah role loyalty nonkas; mapping kas awal pada `:279` memakai akun baru dari chart baru. Penelusuran seed/onboarding/provisioning dan migrasi terkait tidak menemukan jalur cloud lain yang memindahkan role kas ke akun lama berjurnal tanpa pemeriksaan baru.
- `scripts/preflight/1118-shared-cash-mapping.sql`, statement 4: Bukti snapshot dan audit `accounting.account_mappings.replaced` digabung; pembacaan jurnal/audit dibatasi tenant dan legal entity. Relasi mapping mengikat akun ke entity yang sama. Kode akun tetap tidak bisa diubah melalui API (`accounting-accounts.service.ts:230` dan `:246`), sehingga tidak terbukti ada jalur penggantian kode yang menghilangkan pencocokan audit `glCode`.
- `apps/api/src/test/cash-1118-preflight-sql.test.ts:270`: Isi test mencakup snapshot berbeda/role tidak ada, bukti audit untuk jurnal tanpa snapshot, urutan waktu jurnal/audit, mapping tidak berubah, kode berbeda, dan schema drift. Batas mapping tanpa audit maupun jurnal ber-snapshot tetap merupakan pengecualian yang diperiksa manual oleh finance sesuai brief.

## Batas verifikasi dan perubahan

- Pemeriksaan statis memakai `git diff`/`git show`. Tidak menjalankan test database, preflight SQL terhadap database, build, migrasi, atau layanan; penutupan temuan dibatasi pada bukti statis.
- Checkout utama berada di `ux/customer-order-benchmark`, berbeda dari head review. Test pada checkout itu tidak dipakai sebagai bukti bagi head `14e34d887`.
- `pnpm exec prettier --check docs/qa/second-opinion-kas-ronde11-1157.md` gagal dijalankan karena modul `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi untuk review ini. `git diff --no-index --check /dev/null <laporan>` tidak menghasilkan diagnostik whitespace (exit 1 karena berkas baru).
- Hanya laporan ini ditulis. Tidak mengubah kode, progress, Beads, atau berkas lain; tidak commit, push, merge, checkout, membuat worktree, atau menghapus berkas.
