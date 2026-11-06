// UMKM SMART — REST API + public catalog server
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, DATA_DIR } = require('./db');
const { register, login, authRequired, myBusiness } = require('./auth');

const app = express();
app.use(express.json());

// ---------- uploads (product photos / logo) ----------
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 3 * 1024 * 1024 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- helpers ----------
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const bizOf = (userId) => {
  const b = myBusiness(userId);
  if (!b) throw Object.assign(new Error('Profil usaha belum dibuat'), { status: 404 });
  return b;
};
const num = (v) => Math.max(0, Number(v) || 0);

// ---------- auth ----------
app.post('/api/auth/register', wrap((req, res) => {
  const { email, password, businessName, businessPhone, description } = req.body || {};
  const r = register(email, password, { name: businessName, phone: businessPhone, description });
  res.json(r);
}));

app.post('/api/auth/login', wrap((req, res) => {
  res.json(login(req.body && req.body.email, req.body && req.body.password));
}));

app.get('/api/me', authRequired, wrap((req, res) => {
  const b = myBusiness(req.userId);
  res.json({ user: { id: req.userId }, business: b || null });
}));

// ---------- business profile ----------
app.put('/api/business', authRequired, upload.single('logo'), wrap((req, res) => {
  const b = bizOf(req.userId);
  const { name, description, phone } = req.body || {};
  let slug = b.slug;
  if (name && name.trim() && name !== b.name) {
    let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'usaha';
    let candidate = base, i = 2;
    while (db.prepare('SELECT id FROM businesses WHERE slug=? AND user_id<>?').get(candidate, req.userId)) candidate = `${base}-${i++}`;
    slug = candidate;
  }
  const logo = req.file ? `/uploads/${req.file.filename}` : b.logo_path;
  db.prepare('UPDATE businesses SET name=?, slug=?, description=?, phone=?, logo_path=? WHERE id=? AND user_id=?')
    .run((name || b.name).trim(), slug, description ?? b.description, phone ?? b.phone, logo, b.id, req.userId);
  res.json(db.prepare('SELECT * FROM businesses WHERE id=?').get(b.id));
}));

// ---------- products ----------
app.get('/api/products', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  res.json(db.prepare('SELECT * FROM products WHERE user_id=? AND business_id=? ORDER BY id DESC').all(req.userId, b.id));
}));

app.post('/api/products', authRequired, upload.single('photo'), wrap((req, res) => {
  const b = bizOf(req.userId);
  const { name, type, description, price } = req.body || {};
  if (!name || !name.trim()) throw Object.assign(new Error('Nama produk wajib diisi'), { status: 400 });
  const r = db.prepare('INSERT INTO products (user_id,business_id,name,type,description,price,photo_path) VALUES (?,?,?,?,?,?,?)')
    .run(req.userId, b.id, name.trim(), type === 'jasa' ? 'jasa' : 'produk', description || '', num(price), req.file ? `/uploads/${req.file.filename}` : '');
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid));
}));

app.put('/api/products/:id', authRequired, upload.single('photo'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  const { name, type, description, price, active } = req.body || {};
  db.prepare('UPDATE products SET name=?, type=?, description=?, price=?, active=?, photo_path=? WHERE id=? AND user_id=?')
    .run((name ?? p.name).trim(), (type === 'jasa' ? 'jasa' : 'produk'), description ?? p.description, num(price ?? p.price),
      active === undefined ? p.active : (active ? 1 : 0), req.file ? `/uploads/${req.file.filename}` : p.photo_path, p.id, req.userId);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(p.id));
}));

app.delete('/api/products/:id', authRequired, wrap((req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  res.json({ ok: true });
}));

// ---------- customers ----------
app.get('/api/customers', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const rows = db.prepare(`
    SELECT c.*, COUNT(o.id) AS order_count, COALESCE(SUM(CASE WHEN o.status<>'dibatalkan' THEN o.total END),0) AS spent
    FROM customers c LEFT JOIN orders o ON o.customer_id=c.id AND o.user_id=c.user_id
    WHERE c.user_id=? AND c.business_id=? GROUP BY c.id ORDER BY c.id DESC`).all(req.userId, b.id);
  res.json(rows);
}));

app.get('/api/customers/:id', authRequired, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
  c.orders = db.prepare('SELECT * FROM orders WHERE customer_id=? AND user_id=? ORDER BY id DESC').all(c.id, req.userId);
  res.json(c);
}));

app.post('/api/customers', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const { name, phone, address, notes } = req.body || {};
  if (!name || !name.trim()) throw Object.assign(new Error('Nama pelanggan wajib diisi'), { status: 400 });
  const r = db.prepare('INSERT INTO customers (user_id,business_id,name,phone,address,notes) VALUES (?,?,?,?,?,?)')
    .run(req.userId, b.id, name.trim(), phone || '', address || '', notes || '');
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(r.lastInsertRowid));
}));

app.put('/api/customers/:id', authRequired, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
  const { name, phone, address, notes } = req.body || {};
  db.prepare('UPDATE customers SET name=?, phone=?, address=?, notes=? WHERE id=? AND user_id=?')
    .run((name ?? c.name).trim(), phone ?? c.phone, address ?? c.address, notes ?? c.notes, c.id, req.userId);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id));
}));

app.delete('/api/customers/:id', authRequired, wrap((req, res) => {
  const r = db.prepare('DELETE FROM customers WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
  res.json({ ok: true });
}));

// ---------- orders ----------
const STATUSES = ['baru', 'diproses', 'dikirim', 'selesai', 'dibatalkan'];

app.get('/api/orders', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const rows = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, p.name AS product_name
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN products p ON p.id=o.product_id
    WHERE o.user_id=? AND o.business_id=? ORDER BY o.id DESC`).all(req.userId, b.id);
  res.json(rows);
}));

app.post('/api/orders', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const { customer_id, product_id, qty, note, createCash } = req.body || {};
  const q = Math.max(1, Math.floor(num(qty) || 1));
  // Validate referenced rows belong to THIS user (isolation check on every FK)
  let total = num(req.body.total);
  if (customer_id) {
    const c = db.prepare('SELECT id FROM customers WHERE id=? AND user_id=?').get(customer_id, req.userId);
    if (!c) throw Object.assign(new Error('Pelanggan tidak ditemukan'), { status: 400 });
  }
  if (product_id) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND user_id=?').get(product_id, req.userId);
    if (!p) throw Object.assign(new Error('Produk tidak ditemukan'), { status: 400 });
    total = p.price * q;
  }
  const tx = db.transaction(() => {
    const r = db.prepare('INSERT INTO orders (user_id,business_id,customer_id,product_id,qty,total,status,note) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.userId, b.id, customer_id || null, product_id || null, q, total, 'baru', note || '');
    const oid = r.lastInsertRowid;
    if (createCash && total > 0) {
      db.prepare('INSERT INTO cash_entries (user_id,business_id,kind,amount,category,description,date,order_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.userId, b.id, 'masuk', total, 'Penjualan', `Pembayaran pesanan #${oid}`, new Date().toISOString().slice(0, 10), oid);
    }
    return oid;
  });
  const oid = tx();
  res.json(db.prepare('SELECT o.*, c.name AS customer_name, p.name AS product_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN products p ON p.id=o.product_id WHERE o.id=?').get(oid));
}));

app.patch('/api/orders/:id/status', authRequired, wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) throw Object.assign(new Error('Status tidak valid'), { status: 400 });
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=? AND user_id=?").run(status, o.id, req.userId);
  res.json(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
}));

app.delete('/api/orders/:id', authRequired, wrap((req, res) => {
  const r = db.prepare('DELETE FROM orders WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  res.json({ ok: true });
}));

// ---------- cash ----------
app.get('/api/cash', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  res.json(db.prepare('SELECT * FROM cash_entries WHERE user_id=? AND business_id=? ORDER BY date DESC, id DESC').all(req.userId, b.id));
}));

app.post('/api/cash', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const { kind, amount, category, description, date } = req.body || {};
  if (!['masuk', 'keluar'].includes(kind)) throw Object.assign(new Error('Jenis transaksi tidak valid'), { status: 400 });
  if (num(amount) <= 0) throw Object.assign(new Error('Nominal harus lebih dari 0'), { status: 400 });
  const r = db.prepare('INSERT INTO cash_entries (user_id,business_id,kind,amount,category,description,date) VALUES (?,?,?,?,?,?,?)')
    .run(req.userId, b.id, kind, num(amount), category || '', description || '', date || new Date().toISOString().slice(0, 10));
  res.json(db.prepare('SELECT * FROM cash_entries WHERE id=?').get(r.lastInsertRowid));
}));

app.delete('/api/cash/:id', authRequired, wrap((req, res) => {
  const r = db.prepare('DELETE FROM cash_entries WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  res.json({ ok: true });
}));

// ---------- reports ----------
app.get('/api/reports', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const month = String(req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const day = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const sum = (kind, where, args) => num(db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM cash_entries WHERE user_id=? AND business_id=? AND kind=? AND ${where}`).get(req.userId, b.id, kind, ...args).s);
  const report = {
    month,
    harian: { tanggal: day, masuk: sum('masuk', 'date=?', [day]), keluar: sum('keluar', 'date=?', [day]) },
    bulanan: { masuk: sum('masuk', "strftime('%Y-%m',date)=?", [month]), keluar: sum('keluar', "strftime('%Y-%m',date)=?", [month]) },
    pesanan: {
      total: num(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND business_id=? AND strftime('%Y-%m',created_at)=?").get(req.userId, b.id, month).c),
      selesai: num(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND business_id=? AND status='selesai' AND strftime('%Y-%m',created_at)=?").get(req.userId, b.id, month).c),
      omzet: num(db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE user_id=? AND business_id=? AND status<>'dibatalkan' AND strftime('%Y-%m',created_at)=?").get(req.userId, b.id, month).s),
    },
    topProduk: db.prepare(`SELECT p.name, SUM(o.qty) qty, SUM(o.total) revenue FROM orders o JOIN products p ON p.id=o.product_id
      WHERE o.user_id=? AND o.status<>'dibatalkan' AND strftime('%Y-%m',o.created_at)=? GROUP BY p.id ORDER BY revenue DESC LIMIT 5`).all(req.userId, month),
  };
  report.harian.saldo = report.harian.masuk - report.harian.keluar;
  report.bulanan.saldo = report.bulanan.masuk - report.bulanan.keluar;
  res.json(report);
}));

// ---------- CSV export ----------
function toCsv(rows, columns) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}
app.get('/api/export/:table', authRequired, wrap((req, res) => {
  const b = bizOf(req.userId);
  const t = req.params.table;
  let rows, cols, fname;
  if (t === 'produk') { rows = db.prepare('SELECT * FROM products WHERE user_id=?').all(req.userId); cols = ['id','name','type','description','price','active','created_at']; fname = 'produk'; }
  else if (t === 'pesanan') { rows = db.prepare('SELECT o.*, c.name customer_name, p.name product_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id').all(req.userId); cols = ['id','customer_name','product_name','qty','total','status','note','created_at']; fname = 'pesanan'; }
  else if (t === 'pelanggan') { rows = db.prepare('SELECT * FROM customers WHERE user_id=?').all(req.userId); cols = ['id','name','phone','address','notes','created_at']; fname = 'pelanggan'; }
  else if (t === 'kas') { rows = db.prepare('SELECT * FROM cash_entries WHERE user_id=? ORDER BY date').all(req.userId); cols = ['id','kind','amount','category','description','date']; fname = 'kas'; }
  else return res.status(400).json({ error: 'Tabel tidak dikenal' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}-${b.slug}.csv"`);
  res.send(toCsv(rows, cols));
}));

// ---------- PUBLIC catalog (no auth, only public fields) ----------
app.get('/api/public/catalog/:slug', wrap((req, res) => {
  const b = db.prepare('SELECT id,name,slug,description,phone,logo_path FROM businesses WHERE slug=?').get(req.params.slug);
  if (!b) return res.status(404).json({ error: 'Usaha tidak ditemukan' });
  const products = db.prepare('SELECT id,name,type,description,price,photo_path FROM products WHERE business_id=? AND active=1 ORDER BY id').all(b.id);
  res.json({ business: b, products });
}));

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/toko/:slug', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'catalog.html')));
// SPA fallback (Express 5 syntax): serve dashboard for any non-API GET route
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.includes('.')) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`UMKM SMART running on http://localhost:${PORT}`));
module.exports = app;
