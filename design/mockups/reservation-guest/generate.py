"""Generate standalone mockups and an offline review page, without dependencies."""
from pathlib import Path
from base64 import b64encode
import re

ROOT = Path(__file__).resolve().parent
css = (ROOT / 'styles.css').read_text()
font = b64encode((ROOT / 'plus-jakarta-sans-latin.woff2').read_bytes()).decode()
css = css.replace('url(plus-jakarta-sans-latin.woff2)', f'url(data:font/woff2;base64,{font})')
files = ['app.js', 'states-booking.js', 'states-decision.js', 'states-recovery.js', 'shell.js']
js = '\n'.join((ROOT / name).read_text() for name in files)
keys = ['detail', 'reschedule', 'validation', 'submitting', 'pending', 'approved', 'rejected', 'late', 'cancel', 'cancel-late', 'cancelled', 'cancelled-late', 'invalid', 'loading', 'error', 'rate-limit']

def guest():
    return '''<div class="guest-canvas"><div class="guest-shell"><header class="brandbar"><div class="wordmark"><i class="brand-dot" aria-hidden="true"></i>Cafe Legend</div><span>Kelola reservasi</span></header><main id="content" class="state-content" aria-live="polite"></main><footer class="guest-footer"><p>Simpan tautan ini untuk memeriksa reservasi Anda. Jangan bagikan kepada orang lain.</p><p>Butuh bantuan? Balas pesan konfirmasi reservasi.</p></footer></div></div>'''

def page(body, state='detail', review=False):
    return f'''<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Kelola reservasi · Cafe Legend</title><style>{css}</style></head><body class="{'review' if review else 'standalone'}" data-state="{state}">{body}<script>{js}</script></body></html>'''

for state in keys:
    (ROOT / f'{state}.html').write_text(page(guest(), state))

review = '''<div class="review-wrap"><header class="review-head"><p class="eyebrow">Legend · Review mockup · legend-g12il</p><h1>Reservasi, dari sisi tamu</h1><p>Periksa detail, minta jadwal baru, atau batalkan dengan rincian DP yang jelas.</p></header><div class="review-layout"><aside><details id="review-controls" class="review-nav" open><summary>Jelajahi 16 state</summary><nav id="state-nav" class="state-nav" aria-label="Pilih state mockup"></nav><div class="review-note"><p><strong>Data contoh</strong><br>Outlet, jadwal, jumlah tamu, nominal DP, dan batas refund hanya ilustrasi kebijakan saat pemesanan.</p><p><strong>Interaksi lokal</strong><br>Tombol mensimulasikan alur tanpa mengirim permintaan atau memindahkan uang. Form menampilkan fixture tanggal dan jam; pilihan lain belum disimulasikan.</p><p><strong>Catatan kontrak</strong><br>Hasil disetujui/ditolak belum tersedia pada DTO tamu. Guard terlambat baru pada persetujuan staf. Kedua hal harus diselaraskan sebelum UI dibangun.</p><p><strong>Asumsi untuk founder</strong><br>Tamu memeriksa hasil lewat tautan ini; belum dijanjikan pesan hasil otomatis. Waktu dan penalti mengikuti data booking, bukan angka tetap.</p></div></details><p class="review-caption">Acuan: halaman tamu QR. Mobile 390 utama · desktop 1280.</p></aside><section aria-label="Pratinjau halaman tamu"><p class="demo-label" id="state-label">Detail reservasi</p><div class="contract-note" id="contract-note" hidden></div>''' + guest() + '''<p class="review-caption">Rute implementasi: /reservasi/kelola#&lt;token&gt;. Token tidak ditampilkan dalam mockup.</p></section></div></div>'''
(ROOT / 'review.html').write_text(page(review, review=True))
print(f'Generated {len(keys)} states and review.html')
