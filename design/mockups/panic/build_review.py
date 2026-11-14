"""Assemble offline mockups; generated files never call the application API."""

import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent
font = base64.b64encode((ROOT.parent / 'assets/plus-jakarta-sans-latin.woff2').read_bytes()).decode()
css = (ROOT / 'panic.css').read_text().replace('../assets/plus-jakarta-sans-latin.woff2', 'data:font/woff2;base64,' + font)
script = (ROOT / 'mockup.js').read_text()
states = [
    ('incoming', '01', 'Alert masuk', 'Lokasi paling besar; satu tindakan untuk merespons.'),
    ('acknowledged', '02', 'Diambil rekan lain', 'Respons tercatat, keadaan aman belum dikonfirmasi.'),
    ('reconnecting', '03', 'Menyambung ulang', 'Alert terakhir tetap terbaca; statusnya belum diperbarui.'),
    ('unreachable', '04', 'Tidak terjangkau', 'Penerimaan terganggu; arah kembali ke layar PIN.'),
    ('revoked', '05', 'Akses perangkat dicabut', 'Pemantauan dihentikan; tidak menampilkan data alert lama.'),
    ('multiple', '06', 'Beberapa alert beruntun', 'Tiga lokasi terpisah; merespons satu tidak menghapus yang lain.'),
]


def document(title, body, extra=''):
    return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + css + extra + '</style></head><body>' + body + '<script>' + script + '</script></body></html>'


screens = {}
for name, number, title, desc in states:
    content = (ROOT / (name + '.html')).read_text()
    screens[name] = content
    (ROOT / ('state-' + name + '.html')).write_text(document(title + ' · Mockup', content))

alternative = screens['incoming'].replace('panic-screen incoming', 'panic-screen incoming variant-b').replace('incoming-title', 'alternative-title')
(ROOT / 'direction-b.html').write_text(document('Arah B · Seruan darurat', alternative))

review_css = '''
.review-head{padding:36px 40px;background:var(--ink);color:white;display:grid;gap:16px}.review-head h1{font-size:36px;line-height:1.2;letter-spacing:-.04em}.review-head p{max-width:70ch}.review-kicker{font-size:16px;font-weight:700}.review-nav{display:flex;gap:8px;flex-wrap:wrap}.review-nav a{background:white;color:var(--ink);padding:12px 16px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:750;min-height:48px}.review-nav a:focus-visible{outline-color:white}.review-label{padding:28px 40px;border-top:2px solid var(--ink);display:grid;gap:8px;background:var(--canvas)}.review-label h2{font-size:24px}.review-label p{max-width:70ch}.review-label a{color:var(--petrol);font-weight:750;min-height:44px;display:inline-flex;align-items:center}.review-page .panic-screen{min-height:780px}.review-note{padding:32px 40px;display:grid;gap:16px;border-top:2px solid var(--ink)}.review-note h2{font-size:24px}.review-note li+li{margin-top:12px}.review-note ul{padding-left:24px;margin:0}.review-page .screen-body{margin:auto}.review-page .queue-item .details{display:block}.review-page .queue-item .mock-feedback{grid-column:1/-1}.review-page .queue-item .primary,.review-page .queue-item .secondary{grid-row:1/2}.review-head a{color:var(--ink)}@media(max-width:759px){.review-head{padding:28px 20px}.review-head h1{font-size:30px}.review-label,.review-note{padding:24px 20px}.review-page .panic-screen{min-height:844px}.review-page .queue-item .primary,.review-page .queue-item .secondary{grid-row:auto}.review-nav{display:grid;grid-template-columns:1fr 1fr}.review-nav a{padding:12px;font-size:16px}}
'''

body = '<div class="review-page"><header class="review-head"><p class="review-kicker">LEGEND / FASILITAS / GERBANG MOCKUP</p><h1>Alert panik yang langsung terbaca.</h1><p>Enam kondisi perangkat staf. Arah A direkomendasikan: lokasi dominan, status tegas, satu aksi. Semua lokasi, waktu, dan ID di bawah adalah data contoh.</p><nav class="review-nav" aria-label="Kondisi mockup">'
for name, num, title, desc in states:
    body += '<a href="#review-' + name + '">' + num + ' · ' + title + '</a>'
body += '<a href="#review-alternative">Arah B · Alternatif</a></nav><p class="mock-note" style="color:white">Mockup lokal · Tombol mensimulasikan respons · Tidak terhubung ke layanan darurat</p></header><main>'
for name, num, title, desc in states:
    body += '<section id="review-' + name + '" aria-labelledby="review-title-' + name + '"><header class="review-label"><h2 id="review-title-' + name + '">' + num + ' / ' + title + '</h2><p>' + desc + '</p></header>' + screens[name] + '</section>'
body += '<section id="review-alternative" aria-labelledby="review-title-alt"><header class="review-label"><h2 id="review-title-alt">Pilihan arah B / Seruan darurat</h2><p>Merah penuh, seruan terpusat, aksi di bawah. Lebih menyita perhatian; arah A memberi ruang lebih besar untuk membaca lokasi.</p></header>' + alternative + '</section>'
body += '''<section class="review-note"><h2>Catatan untuk persetujuan founder</h2><ul><li>Pilih arah A (lokasi dominan) atau B (seruan merah penuh). Keenam state di atas memakai arah A sebagai usulan.</li><li>Setujui antrean paling awal diterima lebih dulu, tanpa menutup alert lain saat satu alert direspons.</li><li>Setujui arahan memakai perangkat aktif lain dan menghubungi penanggung jawab ketika akses dicabut.</li></ul><p>Nama ruang memerlukan pemetaan ID ke metadata fasilitas. WS belum mengirim perubahan ACK; state rekan lain berasal dari respons ACK 409. Menekan “Saya tangani” berarti menuju lokasi, bukan menutup insiden.</p><p>Tanpa kedip, suara otomatis, atau animasi berulang. Gerak tambahan dimatikan saat reduced motion aktif. Review ini belum menguji perangkat staf asli.</p></section></main></div>'''
(ROOT / 'review.html').write_text(document('Review alert panik staf · Legend', body, review_css))
