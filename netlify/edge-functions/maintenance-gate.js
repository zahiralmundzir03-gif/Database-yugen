function esc(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/.netlify/') || (path !== '/' && path !== '/index.html')) return context.next();
  try {
    const status = await fetch(new URL('/api/maintenance', url), {
      headers: { cookie: request.headers.get('cookie') || '' },
      cache: 'no-store'
    });
    if (!status.ok) return context.next();
    const data = await status.json();
    if (!data.blocked) return context.next();
    const cfg = data.config || {};
    const title = esc(cfg.title || 'Yūgen Nexus Sedang Maintenance');
    const desc = esc(cfg.desc || 'Dashboard sedang dalam pemeliharaan. Silakan coba kembali nanti.').replace(/\n/g, '<br>');
    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at 20% 0%,#20252c,#090a0d 65%);color:#f5f5f5;font:16px Inter,system-ui,sans-serif}.card{width:min(100%,520px);padding:34px;border:1px solid #343943;border-radius:22px;background:rgba(18,20,25,.94);box-shadow:0 25px 90px #0008}.mark{width:58px;height:58px;display:grid;place-items:center;border-radius:18px;background:#1d3329;color:#67d99a;font-size:27px;margin-bottom:22px}.eyebrow{font-size:11px;letter-spacing:.22em;color:#8d949f;text-transform:uppercase}.title{font-size:clamp(25px,6vw,36px);line-height:1.15;margin:12px 0}.desc{color:#aeb4be;line-height:1.8;white-space:normal}.form{border-top:1px solid #30343c;margin-top:26px;padding-top:22px}.form h2{font-size:14px;margin:0 0 12px}.field{margin:12px 0}.field label{display:block;font-size:12px;color:#aeb4be;margin-bottom:6px}.field input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #383e48;background:#0d0f13;color:white;font:inherit}.btn{width:100%;padding:13px;border:0;border-radius:10px;background:#42c982;color:#07140c;font-weight:800;cursor:pointer}.msg{min-height:20px;margin:10px 0;color:#ffb4a8;font-size:12px}.foot{margin-top:20px;color:#68717e;font-size:10px;letter-spacing:.18em;text-align:center}</style></head><body><main class="card"><div class="mark">✦</div><div class="eyebrow">Yūgen Nexus · Server Maintenance</div><h1 class="title">${title}</h1><p class="desc">${desc}</p><form class="form" id="owner-login"><h2>Akses Pemilik</h2><div class="field"><label for="email">Email pemilik</label><input id="email" type="email" autocomplete="username" required></div><div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div><div class="msg" id="msg" role="status"></div><button class="btn" type="submit">Masuk sebagai pemilik</button></form><div class="foot">YŪGEN NEXUS · PRIVATE MAINTENANCE GATE</div></main><script>document.getElementById('owner-login').addEventListener('submit',async function(e){e.preventDefault();const msg=document.getElementById('msg');const btn=this.querySelector('button');btn.disabled=true;msg.textContent='Memverifikasi akun...';try{const r=await fetch('/api/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Login gagal');if(!d.user||d.user.role!=='owner')throw new Error('Hanya akun owner yang dapat membuka dashboard selama maintenance.');location.replace('/');}catch(err){msg.textContent=err.message;btn.disabled=false;}});</script></body></html>`;
    return new Response(html, { status: 503, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'retry-after':'300' } });
  } catch (e) {
    console.error('Maintenance edge gate:', e);
    return context.next();
  }
};
