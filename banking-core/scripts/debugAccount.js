require('dotenv').config();
const BASE = `http://localhost:${process.env.PORT || 3000}`;
async function call(method, path, { token, body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log(method, path, '->', res.status, await res.text());
}
(async () => {
  const email = `dbg${Date.now()}@test.dev`;
  await call('POST', '/api/auth/register', { body: { name: 'Dbg', email, password: 'pw123456' } });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw123456' }),
  })).json();
  await call('POST', '/api/ledger/accounts', { token: login.accessToken, key: 'dbg-' + Date.now(), body: { accountType: 'SAVINGS' } });
  await call('POST', '/api/ledger/accounts', { token: login.accessToken, key: 'dbg2-' + Date.now(), body: { accountType: 'FEES' } });
  await call('GET', '/api/ledger/accounts', { token: login.accessToken });
})();