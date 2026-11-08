const requested=new URLSearchParams(location.search).get('screen');
const screens=[...document.querySelectorAll('.screen')];
const active=screens.find(s=>s.dataset.screen===requested)||screens[0];
active?.classList.add('active');
const staff=active?.dataset.role||document.body.dataset.role||'Kasir 01';
const header=document.createElement('header');header.className='topbar';header.innerHTML='<div class="brand"><strong>Legend / Kasir</strong><span class="muted">Cafe Legend · Terminal 01</span></div><div class="meta"><span class="pill success">✓ Terhubung</span><span>'+staff+'</span><strong>14.32</strong><span class="review-only">Contoh data · Mockup</span></div>';document.body.prepend(header);
