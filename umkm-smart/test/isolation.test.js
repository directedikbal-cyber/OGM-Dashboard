// Tenant isolation test — verifies user A can NEVER read/write user B's data.
process.env.DATA_DIR = require('path').join(__dirname, '..', 'data-test');
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require('http');
const assert = require('assert');
const app = require('../src/server');

let server, base;
const req = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
    let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf) } catch { return buf } })() }));
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});

(async () => {
  await new Promise((r) => { server = app.listen(0, r) });
  base = 'http://127.0.0.1:' + server.address().port;

  // Register two tenants
  const A = (await req('POST', '/api/auth/register', { body: { email: 'a@test.id', password: 'rahasia1', businessName: 'Toko A', businessPhone: '62811' } })).json;
  const B = (await req('POST', '/api/auth/register', { body: { email: 'b@test.id', password: 'rahasia2', businessName: 'Toko B', businessPhone: '62822' } })).json;
  assert(A.token && B.token && A.slug !== B.slug, 'registration should return tokens and unique slugs');

  // A creates product + customer + order
  const prodA = (await req('POST', '/api/products', { token: A.token, body: { name: 'Keripik A', price: 5000 } })).json;
  const custA = (await req('POST', '/api/customers', { token: A.token, body: { name: 'Bu Aminah', phone: '62833' } })).json;
  const ordA = (await req('POST', '/api/orders', { token: A.token, body: { customer_id: custA.id, product_id: prodA.id, qty: 2, createCash: true } })).json;
  assert(ordA.total === 10000, 'order total should be price*qty');

  // ISOLATION CHECKS — B must not see or touch any of A's rows
  const listB = await req('GET', '/api/products', { token: B.token });
  assert(listB.json.length === 0, 'B must not see A products in listing');
  const listOrdB = await req('GET', '/api/orders', { token: B.token });
  assert(listOrdB.json.length === 0, 'B must not see A orders');
  const cashB = await req('GET', '/api/cash', { token: B.token });
  assert(cashB.json.length === 0, 'B must not see A cash entries');

  const getCross = await req('PUT', `/api/products/${prodA.id}`, { token: B.token, body: { name: 'HACKED' } });
  assert(getCross.status === 404, 'B editing A product must 404');
  const delCross = await req('DELETE', `/api/customers/${custA.id}`, { token: B.token });
  assert(delCross.status === 404, 'B deleting A customer must 404');
  const stCross = await req('PATCH', `/api/orders/${ordA.id}/status`, { token: B.token, body: { status: 'selesai' } });
  assert(stCross.status === 404, 'B changing A order status must 404');

  // B cannot reference A's rows when creating an order (FK ownership validation)
  const fakeOrder = await req('POST', '/api/orders', { token: B.token, body: { product_id: prodA.id, qty: 1 } });
  assert(fakeOrder.status === 400, 'B must not use A product id in own order');

  // Unauthenticated access blocked
  const noAuth = await req('GET', '/api/products');
  assert(noAuth.status === 401, 'no token -> 401');

  // Public catalog only exposes active public fields of the right tenant
  const cat = await req('GET', '/api/public/catalog/' + A.slug);
  assert(cat.json.products.length === 1 && cat.json.products[0].name === 'Keripik A', 'catalog shows A products only');
  assert(!('user_id' in cat.json.products[0]) && !('business_id' in cat.json.business), 'public payload must not leak internal ids');
  const catB = await req('GET', '/api/public/catalog/' + B.slug);
  assert(catB.json.products.length === 0, 'B catalog empty');

  // Reports are per-tenant
  const repA = await req('GET', '/api/reports', { token: A.token }).then(r => r.json);
  const month = new Date().toISOString().slice(0, 7);
  assert(repA.bulanan.masuk === 10000, 'A report includes own sale');
  const repB = await req('GET', '/api/reports', { token: B.token }).then(r => r.json);
  assert(repB.bulanan.masuk === 0, 'B report must be zero');

  // CSV export scoped to owner
  const csv = await new Promise((resolve) => {
    http.get(base + '/api/export/pesanan', { headers: { Authorization: 'Bearer ' + B.token } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)) });
  });
  assert(!csv.includes('Keripik A'), 'B CSV export must not contain A data');

  console.log('✅ All tenant-isolation tests passed.');
  server.close();
  process.exit(0);
})().catch((e) => { console.error('❌ TEST FAILED:', e.message); process.exit(1) });
