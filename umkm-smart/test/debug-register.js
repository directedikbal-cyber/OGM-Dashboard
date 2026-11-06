process.env.DATA_DIR = '/tmp/dbgC';
require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const auth = require('../src/auth');
try {
  const r = auth.register('v@t.id', 'rahasia1', { name: 'Toko V' });
  console.log('OK result:', JSON.stringify(r));
} catch (e) {
  console.log('ERR:', e.message);
}
