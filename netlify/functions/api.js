const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let sqlInstance = null;
const sql = (strings, ...values) => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum dikonfigurasi.');
  if (!sqlInstance) sqlInstance = neon(process.env.DATABASE_URL);
  return sqlInstance(strings, ...values);
};
const JWT_SECRET = process.env.JWT_SECRET || '';
const ACCOUNT_BOT_TOKEN = process.env.TELEGRAM_ACCOUNT_BOT_TOKEN || '';
const REPORT_BOT_TOKEN = process.env.TELEGRAM_REPORT_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_BOOTSTRAP_PASSWORD = String(process.env.OWNER_BOOTSTRAP_PASSWORD || '');
const COOKIE = 'yn_session';

function response(statusCode, data, headers={}) {
  return { statusCode, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }, body: JSON.stringify(data) };
}
function cookieOptions(value, maxAge=60*60*24*14) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function getCookie(event, name) {
  const raw = event.headers?.cookie || event.headers?.Cookie || '';
  const found = raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return found ? decodeURIComponent(found.slice(name.length+1)) : '';
}
function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}
function requireEnv() {
  const missing = ['DATABASE_URL','JWT_SECRET','TELEGRAM_ACCOUNT_BOT_TOKEN','TELEGRAM_REPORT_BOT_TOKEN','TELEGRAM_CHAT_ID','OWNER_EMAIL','TELEGRAM_WEBHOOK_SECRET'].filter(k=>!process.env[k]);
  if (missing.length) throw new Error('Konfigurasi Netlify belum lengkap: '+missing.join(', '));
}
async function telegram(method, payload, token=ACCOUNT_BOT_TOKEN) {
  if (!token || !CHAT_ID) return null;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.ok) throw new Error(d.description || `Telegram HTTP ${r.status}`);
  return d.result;
}
async function notify(text, keyboard, token=ACCOUNT_BOT_TOKEN) {
  if (!token || !CHAT_ID) return;
  const payload = { chat_id:CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true };
  if (keyboard) payload.reply_markup = { inline_keyboard:keyboard };
  await telegram('sendMessage', payload, token);
}
function publicUser(row) {
  return { id:row.id, uuid:row.id, username:row.username, email:row.email, role:row.role, verified:true,
    createdAt:new Date(row.created_at).getTime(), lastLogin:row.last_login ? new Date(row.last_login).getTime() : null };
}
function getPath(event) {
  const p = event.path || '';
  const marker = '/.netlify/functions/api';
  const i = p.indexOf(marker);
  return i >= 0 ? (p.slice(i+marker.length) || '/') : p.replace(/^\/api/, '') || '/';
}
async function currentUser(event) {
  const token = getCookie(event, COOKIE);
  if (!token || !JWT_SECRET) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const rows = await sql`SELECT id, username, email, role, created_at, last_login, role_expires_at FROM yn_users WHERE id=${claims.sub} LIMIT 1`;
    if (rows[0] && rows[0].role_expires_at && new Date(rows[0].role_expires_at).getTime() <= Date.now() && !['owner','developers'].includes(rows[0].role)) {
      const reset = await sql`UPDATE yn_users SET role='basic', role_expires_at=NULL WHERE id=${claims.sub} RETURNING id,username,email,role,created_at,last_login`;
      return reset[0] || null;
    }
    return rows[0] || null;
  } catch { return null; }
}
async function admin(event) {
  const user = await currentUser(event);
  if (!user || !['owner','developers'].includes(user.role)) throw Object.assign(new Error('Akses admin ditolak.'), {status:403});
  return user;
}
async function sendReportPhoto(reportId, body, user) {
  if (!body.image) return;
  const bytes = Buffer.from(body.image, 'base64');
  if (!bytes.length || bytes.length > 3500*1024) throw new Error('Foto maksimal 3,5 MB.');
  const mime = ['image/jpeg','image/png','image/webp'].includes(body.imageType) ? body.imageType : 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', `Screenshot laporan #${reportId} · @${user.username}`);
  form.append('photo', new Blob([bytes], {type:mime}), `error-${reportId}.${ext}`);
  const r = await fetch(`https://api.telegram.org/bot${REPORT_BOT_TOKEN}/sendPhoto`, {method:'POST',body:form});
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.ok) throw new Error(d.description || 'Telegram gagal menerima foto.');
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  const path = getPath(event);
  const body = parseBody(event);
  try {
    if (path === '/telegram-webhook' && method === 'POST') {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
      const supplied = event.headers?.['x-telegram-bot-api-secret-token'] || event.headers?.['X-Telegram-Bot-Api-Secret-Token'] || '';
      if (!secret || supplied !== secret) return response(401,{success:false,error:'Unauthorized'});
      const update = body;
      const q = update.callback_query;
      if (q && String(q.data || '').startsWith('yn_report_ack:')) {
        const id = Number(String(q.data).split(':')[1]);
        const rows = await sql`UPDATE yn_reports SET status='accepted', accepted_at=NOW() WHERE id=${id} RETURNING id, user_id`;
        if (rows[0]) {
          await telegram('answerCallbackQuery',{callback_query_id:q.id,text:'Laporan diterima.'},REPORT_BOT_TOKEN);
          await telegram('editMessageReplyMarkup',{chat_id:q.message.chat.id,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}},REPORT_BOT_TOKEN);
        } else await telegram('answerCallbackQuery',{callback_query_id:q.id,text:'Laporan tidak ditemukan.'},REPORT_BOT_TOKEN);
      }
      return response(200,{ok:true});
    }
    requireEnv();

    if (path === '/register' && method === 'POST') {
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return response(400,{success:false,error:'Username 3–32 karakter dan hanya huruf, angka, titik, _ atau -.'});
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response(400,{success:false,error:'Email tidak valid.'});
      if (password.length < 3) return response(400,{success:false,error:'Password minimal 3 karakter.'});
      if (Buffer.byteLength(password,'utf8') > 72) return response(400,{success:false,error:'Password maksimal 72 byte agar dapat di-hash dengan aman.'});
      const owner = email === OWNER_EMAIL && username.toLowerCase() === 'zill' && password === OWNER_BOOTSTRAP_PASSWORD;
      if (username.toLowerCase() === 'zill' && !owner) return response(403,{success:false,error:'Akun pemilik membutuhkan email dan password bootstrap yang telah diatur di Netlify.'});
      if (email === OWNER_EMAIL && !owner) return response(403,{success:false,error:'Email pemilik hanya boleh dipakai untuk membuat akun zill.'});
      const duplicate = await sql`SELECT id FROM yn_users WHERE lower(username)=lower(${username}) OR lower(email)=lower(${email}) LIMIT 1`;
      if (duplicate.length) return response(409,{success:false,error:'Username atau email sudah digunakan.'});
      const hash = await bcrypt.hash(password,12);
      const rows = await sql`INSERT INTO yn_users (username,email,password_hash,role) VALUES (${username},${email},${hash},${owner?'owner':'basic'}) RETURNING id,username,email,role,created_at,last_login`;
      const user = publicUser(rows[0]);
      const token = jwt.sign({sub:user.id},JWT_SECRET,{expiresIn:'14d'});
      try { await notify(`✨ <b>Akun Baru Berhasil Dibuat</b>\n\n👤 Username: <code>${escapeHtml(username)}</code>\n📧 Email: <code>${escapeHtml(email)}</code>\n🛡️ Role: <b>${user.role}</b>\n🆔 ID: <code>${user.id}</code>\n\n✅ Akun berhasil dibuat.\n🔐 Password tersimpan dalam bentuk hash dan tidak dikirim melalui Telegram.`); } catch (e) { console.error('Telegram registration notification failed:', e); }
      return response(201,{success:true,user},{'Set-Cookie':cookieOptions(token)});
    }
    if (path === '/profile' && method === 'POST') {
      const user = await currentUser(event);
      if (!user) return response(401,{success:false,error:'Login diperlukan.'});
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      const username = String(body.username || '').trim();
      const rows = await sql`SELECT id,username,email,password_hash,role,created_at,last_login FROM yn_users WHERE id=${user.id} LIMIT 1`;
      if (!rows[0] || !(await bcrypt.compare(oldPassword, rows[0].password_hash))) return response(401,{success:false,error:'Password lama tidak cocok.'});
      if (newPassword && (newPassword.length < 3 || Buffer.byteLength(newPassword,'utf8') > 72)) return response(400,{success:false,error:'Password baru harus 3–72 byte.'});
      if (username && !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return response(400,{success:false,error:'Username harus 3–32 karakter.'});
      if (username && username.toLowerCase() !== rows[0].username.toLowerCase()) {
        const dup = await sql`SELECT id FROM yn_users WHERE lower(username)=lower(${username}) AND id<>${user.id} LIMIT 1`;
        if (dup.length) return response(409,{success:false,error:'Username sudah digunakan.'});
      }
      const hash = newPassword ? await bcrypt.hash(newPassword,12) : rows[0].password_hash;
      const newName = username || rows[0].username;
      const updated = await sql`UPDATE yn_users SET username=${newName}, password_hash=${hash} WHERE id=${user.id} RETURNING id,username,email,role,created_at,last_login`;
      try { await notify(`✏️ <b>Profil diperbarui</b>\nUsername: <code>${escapeHtml(rows[0].username)}</code> → <code>${escapeHtml(newName)}</code>\nPassword: ${newPassword?'diubah':'tidak diubah'}\nID: <code>${user.id}</code>`); } catch(e) { console.error('Profile notification failed:',e); }
      return response(200,{success:true,user:publicUser(updated[0])});
    }
    if (path === '/login' && method === 'POST') {
      const email=String(body.email||'').trim().toLowerCase(), password=String(body.password||'');
      const rows=await sql`SELECT id,username,email,password_hash,role,created_at,last_login FROM yn_users WHERE lower(email)=${email} LIMIT 1`;
      if (!rows[0] || !(await bcrypt.compare(password,rows[0].password_hash))) return response(401,{success:false,error:'Email atau password salah.'});
      const updated=await sql`UPDATE yn_users SET last_login=NOW() WHERE id=${rows[0].id} RETURNING id,username,email,role,created_at,last_login`;
      const user=publicUser(updated[0]); const token=jwt.sign({sub:user.id},JWT_SECRET,{expiresIn:'14d'});
      return response(200,{success:true,user},{'Set-Cookie':cookieOptions(token)});
    }
    if (path === '/logout' && method === 'POST') return response(200,{success:true},{'Set-Cookie':cookieOptions('',0)});
    if (path === '/me' && method === 'GET') { const u=await currentUser(event); return response(200,{success:true,user:u?publicUser(u):null}); }
    if (path === '/maintenance' && method === 'GET') {
      const rows=await sql`SELECT value FROM yn_settings WHERE key='maintenance' LIMIT 1`;
      const cfg=rows[0]?.value || {enabled:false,title:'Yūgen Nexus Sedang Maintenance',desc:'Server sedang dalam pemeliharaan.',btnText:'Info Selengkapnya',url:''};
      const u=await currentUser(event);
      return response(200,{success:true,config:cfg,blocked:!!cfg.enabled && !(u && u.role === 'owner')});
    }
    if (path === '/maintenance' && method === 'POST') {
      const u=await admin(event);
      const cfg={enabled:!!body.enabled,title:String(body.title||'Maintenance').slice(0,120),desc:String(body.desc||'').slice(0,3000),btnText:String(body.btnText||'Info').slice(0,80),url:String(body.url||'').slice(0,500)};
      if(cfg.url && !/^https?:\/\//i.test(cfg.url)) return response(400,{success:false,error:'URL harus http atau https.'});
      await sql`INSERT INTO yn_settings(key,value,updated_by) VALUES ('maintenance',${JSON.stringify(cfg)}::jsonb,${u.id}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      await notify(`🛠️ <b>Maintenance ${cfg.enabled?'DIAKTIFKAN':'DINONAKTIFKAN'}</b>\nOleh: @${escapeHtml(u.username)}\nJudul: ${escapeHtml(cfg.title)}\nPesan: ${escapeHtml(cfg.desc)}`);
      return response(200,{success:true,config:cfg});
    }
    if (path === '/admin/users' && method === 'GET') {
      await admin(event);
      const rows=await sql`SELECT id,username,email,role,created_at,last_login,role_expires_at FROM yn_users ORDER BY created_at DESC LIMIT 500`;
      return response(200,{success:true,users:rows.map(publicUser)});
    }
    if (path === '/admin/role' && method === 'POST') {
      const actor=await admin(event), username=String(body.username||''), role=String(body.role||''), duration=String(body.duration||'permanent');
      if(!['basic','vip','developers','owner'].includes(role)) return response(400,{success:false,error:'Role tidak valid.'});
      if(actor.role!=='owner' && ['owner','developers'].includes(role)) return response(403,{success:false,error:'Hanya owner yang dapat memberikan role admin/owner.'});
      if(username.toLowerCase()==='zill' && role!=='owner') return response(403,{success:false,error:'Akun pemilik tidak dapat diturunkan rolenya.'});
      if (!['1d','7d','30d','permanent'].includes(duration)) return response(400,{success:false,error:'Durasi role tidak valid.'});
      if (['owner','developers'].includes(role) && duration !== 'permanent') return response(400,{success:false,error:'Owner dan Developers harus permanen.'});
      const expiry = duration==='1d' ? new Date(Date.now()+86400000) : duration==='7d' ? new Date(Date.now()+7*86400000) : duration==='30d' ? new Date(Date.now()+30*86400000) : null;
      const rows=await sql`UPDATE yn_users SET role=${role}, role_expires_at=${expiry} WHERE lower(username)=lower(${username}) RETURNING id,username,email,role,created_at,last_login`;
      if(!rows[0]) return response(404,{success:false,error:'User tidak ditemukan.'});
      await notify(`🔐 <b>Role Akun Diubah</b>\nTarget: @${escapeHtml(username)}\nRole baru: <b>${role}</b>\nOleh: @${escapeHtml(actor.username)}\n✅ Berhasil.`);
      return response(200,{success:true,user:publicUser(rows[0])});
    }
    if (path === '/admin/delete' && method === 'POST') {
      const actor=await admin(event), username=String(body.username||'');
      if(username.toLowerCase()==='zill') return response(403,{success:false,error:'Akun pemilik tidak dapat dihapus.'});
      const target=await sql`SELECT role FROM yn_users WHERE lower(username)=lower(${username}) LIMIT 1`;
      if(target[0]?.role==='owner' && actor.role!=='owner') return response(403,{success:false,error:'Hanya owner yang dapat menghapus akun owner lain.'});
      const rows=await sql`DELETE FROM yn_users WHERE lower(username)=lower(${username}) RETURNING id,username,email`;
      if(!rows[0]) return response(404,{success:false,error:'User tidak ditemukan.'});
      await notify(`🗑️ <b>Akun Dihapus</b>\nUsername: @${escapeHtml(rows[0].username)}\nEmail: ${escapeHtml(rows[0].email)}\nOleh: @${escapeHtml(actor.username)}\n✅ Berhasil.`);
      return response(200,{success:true});
    }
    if (path === '/report' && method === 'POST') {
      const user=await currentUser(event);
      if(!user) return response(401,{success:false,error:'Login terlebih dahulu.'});
      const description=String(body.description||'').trim();
      if(!description || description.length>4000) return response(400,{success:false,error:'Deskripsi wajib diisi (maksimal 4000 karakter).'});
      if(body.image && Buffer.from(body.image,'base64').length>3500*1024) return response(400,{success:false,error:'Foto maksimal 3,5 MB.'});
      const rows=await sql`INSERT INTO yn_reports(user_id,description,status) VALUES (${user.id},${description},'pending') RETURNING id`;
      const id=rows[0].id;
      let photoError=''; if(body.image) { try { await sendReportPhoto(id,body,user); } catch(e) { photoError=' Foto gagal diteruskan: '+e.message; console.error(e); } }
      const caption=`🚨 <b>Laporan Bug Baru #${id}</b>\n\n👤 Akun: @${escapeHtml(user.username)}\n📧 Email: <code>${escapeHtml(user.email)}</code>\n🆔 User ID: <code>${user.id}</code>\n\n📝 <b>Penjelasan:</b>\n${escapeHtml(description)}\n\n📷 Foto: ${body.image?(photoError?'Gagal dikirim':'Terlampir'):'Tidak disertakan'}${escapeHtml(photoError)}\n⏳ Status: Menunggu diterima`;
      await notify(caption,[[{text:'✅ Laporan Diterima',callback_data:`yn_report_ack:${id}`}]],REPORT_BOT_TOKEN);
      return response(201,{success:true,reportId:id,status:'pending'});
    }
    if (path === '/report-status' && method === 'GET') {
      const user=await currentUser(event); if(!user) return response(401,{success:false,error:'Login diperlukan.'});
      const id=Number(event.queryStringParameters?.id||0);
      const rows=await sql`SELECT id,status,accepted_at FROM yn_reports WHERE id=${id} AND user_id=${user.id} LIMIT 1`;
      if(!rows[0]) return response(404,{success:false,error:'Laporan tidak ditemukan.'});
      return response(200,{success:true,status:rows[0].status,acceptedAt:rows[0].accepted_at});
    }
    if (path === '/deploy' && method === 'POST') { await currentUser(event).then(u=>{if(!u)throw Object.assign(new Error('Login diperlukan.'),{status:401});}); return response(501,{success:false,error:'Fitur deploy membutuhkan adapter provider yang belum dikonfigurasi.'}); }
    return response(404,{success:false,error:'Endpoint tidak ditemukan.'});
  } catch (err) {
    console.error('API error:',err);
    return response(err.status || 500,{success:false,error:err.status?err.message:'Terjadi kesalahan server. Periksa konfigurasi dan log Netlify.'});
  }
};
function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
