// Auth: JWT-based session + strict per-user (tenant) isolation middleware.
// Design rule: req.userId is ONLY ever taken from a verified JWT — never from
// client-supplied body/query — so user A can never read or write user B's rows.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const TOKEN_TTL = '7d';

function sign(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: TOKEN_TTL });
}

function register(email, password, biz) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Email tidak valid'), { status: 400 });
  if (!password || password.length < 6) throw Object.assign(new Error('Password minimal 6 karakter'), { status: 400 });
  if (!biz.name) throw Object.assign(new Error('Nama usaha wajib diisi'), { status: 400 });

  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (exists) throw Object.assign(new Error('Email sudah terdaftar'), { status: 409 });

  let tx;
  try {
    tx = db.transaction(() => {
      const hash = bcrypt.hashSync(password, 10);
      const u = db.prepare('INSERT INTO users (email,password_hash) VALUES (?,?)').run(email, hash);
      const userId = Number(u.lastInsertRowid);
      let slug = String(biz.slug || biz.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'usaha';
      let candidate = slug, i = 2;
      while (db.prepare('SELECT id FROM businesses WHERE slug=?').get(candidate)) candidate = `${slug}-${i++}`;
      const b = db.prepare('INSERT INTO businesses (user_id,name,slug,description,phone) VALUES (?,?,?,?,?)')
        .run(userId, biz.name.trim(), candidate, biz.description || '', biz.phone || '');
      return { userId, businessId: Number(b.lastInsertRowid), slug: candidate };
    })();
  } catch (e) {
    console.error('[register] DB error:', e && e.stack || e);
    throw Object.assign(new Error('Gagal menyimpan data usaha: ' + (e.message || e)), { status: 500 });
  }

  if (!tx || !tx.userId || !tx.slug) {
    console.error('[register] unexpected tx result:', JSON.stringify(tx));
    throw Object.assign(new Error('Terjadi kesalahan sistem saat registrasi'), { status: 500 });
  }
  return { token: sign(tx.userId), userId: tx.userId, businessId: tx.businessId, slug: tx.slug };
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw Object.assign(new Error('Email atau password salah'), { status: 401 });
  }
  return { token: sign(user.id), userId: user.id };
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Belum login' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = Number(payload.sub);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang' });
  }
}

// Load the caller's own business; 404 if missing. Never accepts business id from client.
function myBusiness(userId) {
  return db.prepare('SELECT * FROM businesses WHERE user_id=?').get(userId);
}

module.exports = { register, login, authRequired, myBusiness, SECRET };
