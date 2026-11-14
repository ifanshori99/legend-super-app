# detail kartu (bd show)

```
◐ legend-esnvi · Fixture event leave.rededucted_after_settlement di packages/shared/src/hris/fixtures.ts supaya tes PII payload mencakupnya   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Saran dari 840 (309c541b8).                                                 



NOTES

  Codex G7hph brief 859                                                       



LABELS: hris, test

```

```
◐ legend-5v8sm · API daftar pesanan delivery: parameter filter 'perlu tindakan' (filter klien saat ini hanya menyaring halaman termuat)   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Saran 846 (cf54e925e).                                                      



NOTES

  Codex G7hph brief 859                                                       



LABELS: delivery

```

```
◐ legend-s3ex8 [BUG] · Dana tak teralokasi: status needs_review menimpa resolved (dana selesai yang buktinya berubah tampil 'Perlu dicek')   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: bug
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Temuan architect 845 (43e9824fa, legend-ftqf), tampilan saja.               



NOTES

  Codex G7hph brief 859                                                       



LABELS: payment, ui

```

```
◐ legend-nb2mk · Perangkat alarm panik: indeks push_subscriptions(user_id) untuk app.list_own_push_devices   [P3 · IN_PROGRESS]
Created by: Ilham fadillah Anshori · Type: task
Created: 2026-11-14 · Started: 2026-11-14 · Updated: 2026-11-14

DESCRIPTION

  Temuan architect legend-fonnr #5: GET/DELETE /api/identity/push-devices     
  memindai seluruh push_subscriptions lintas tenant (tidak ada indeks         
  berawalan user_id; cast ps.user_id::text di sisi subscription). Tambah      
  indeks user_id dan ubah perbandingan ke ps.user_id = owner::uuid bila       
  session.user_id selalu uuid.                                                



NOTES

  Codex G7hph brief 859                                                       



```
