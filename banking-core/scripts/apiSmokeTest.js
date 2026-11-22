// Run with: node scripts/apiSmokeTest.js      (the server must be running: npm run dev)
// Walks through every feature the front end will use, over real HTTP, and
// prints PASS/FAIL for each. Creates two fresh users each run.
require('dotenv').config();
const { User } = require('../src/models');

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
let failures = 0;
let keyCounter = 0;
const newKey = () => `smoke-${Date.now()}-${keyCounter++}`;

function check(label, ok, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, path, { token, body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json };
}

async function registerAndLogin(name, email) {
  await api('POST', '/api/auth/register', { body: { name, email, password: 'pw123456' } });
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'pw123456' } });
  return login.body;
}

async function run() {
  const stamp = Date.now();
  const emailA = `alice${stamp}@smoke.test`;
  const emailB = `bob${stamp}@smoke.test`;

  console.log('\n--- Auth ---');
  let a = await registerAndLogin('Alice Smoke', emailA);
  const b = await registerAndLogin('Bob Smoke', emailB);
  check('login returns tokens', !!a.accessToken && !!a.refreshToken);
  const me = await api('GET', '/api/auth/me', { token: a.accessToken });
  check('/me returns my profile', me.status === 200 && me.body.email === emailA && me.body.role === 'USER');

  console.log('\n--- Accounts ---');
  const accA = (await api('POST', '/api/ledger/accounts', { token: a.accessToken, key: newKey(), body: { accountType: 'SAVINGS' } })).body;
  const accB = (await api('POST', '/api/ledger/accounts', { token: b.accessToken, key: newKey(), body: { accountType: 'SAVINGS' } })).body;
  check('accounts opened', !!accA.id && !!accB.id);
  const badType = await api('POST', '/api/ledger/accounts', { token: a.accessToken, key: newKey(), body: { accountType: 'FEES' } });
  check('cannot open a FEES account', badType.status === 400);
  const dupKey = newKey();
  const c1 = await api('POST', '/api/ledger/accounts', { token: a.accessToken, key: dupKey, body: { accountType: 'CURRENT' } });
  const c2 = await api('POST', '/api/ledger/accounts', { token: a.accessToken, key: dupKey, body: { accountType: 'CURRENT' } });
  check('double-click does not open two accounts (idempotency)', c1.body.id === c2.body.id);
  const list = await api('GET', '/api/ledger/accounts', { token: a.accessToken });
  check('account list shows my 2 accounts', list.status === 200 && list.body.length === 2);

  console.log('\n--- Deposit ---');
  const depKey = newKey();
  const dep = await api('POST', `/api/ledger/accounts/${accA.id}/deposit`, { token: a.accessToken, key: depKey, body: { amountPaise: 500000 } });
  check('deposit of ₹5,000 works', dep.status === 201 && dep.body.balancePaise === 500000, JSON.stringify(dep.body.balancePaise));
  const dep2 = await api('POST', `/api/ledger/accounts/${accA.id}/deposit`, { token: a.accessToken, key: depKey, body: { amountPaise: 500000 } });
  check('retrying the same deposit key does not deposit twice', dep2.body.transactionId === dep.body.transactionId);
  const depOther = await api('POST', `/api/ledger/accounts/${accB.id}/deposit`, { token: a.accessToken, key: newKey(), body: { amountPaise: 100 } });
  check("cannot deposit into someone else's account", depOther.status === 403);
  const depHuge = await api('POST', `/api/ledger/accounts/${accA.id}/deposit`, { token: a.accessToken, key: newKey(), body: { amountPaise: 999999999 } });
  check('deposit above the cap is rejected', depHuge.status === 400);

  console.log('\n--- Sending money ---');
  const quote = await api('GET', '/api/ledger/fee-quote?amountPaise=50000', { token: a.accessToken });
  check('fee quote for ₹500 is ₹2.50', quote.status === 200 && quote.body.feePaise === 250 && quote.body.totalDebitPaise === 50250);
  const lookup = await api('GET', `/api/ledger/directory?email=${encodeURIComponent(emailB.toUpperCase())}`, { token: a.accessToken });
  check('recipient lookup by email (case-insensitive)', lookup.status === 200 && lookup.body.accounts[0].id === accB.id);
  const noUser = await api('GET', '/api/ledger/directory?email=nobody@nowhere.test', { token: a.accessToken });
  check('unknown email gives 404', noUser.status === 404);
  const tr = await api('POST', '/api/ledger/transfer', { token: a.accessToken, key: newKey(), body: { fromAccountId: accA.id, toAccountId: accB.id, amountPaise: 50000 } });
  check('transfer charged the fee', tr.status === 201 && tr.body.feePaise === 250);

  console.log('\n--- History (the double-entry view) ---');
  const hist = await api('GET', `/api/ledger/accounts/${accA.id}/transactions`, { token: a.accessToken });
  const latest = hist.body.items && hist.body.items[0];
  check('history returns newest transfer first', hist.status === 200 && latest && latest.transactionId === tr.body.transactionId);
  check('transfer shows 3 legs (1 debit, 2 credits)', latest && latest.legs.length === 3 && latest.legs.filter((l) => l.direction === 'DEBIT').length === 1);
  check('legs balance: debits == credits', latest && latest.debitTotalPaise === latest.creditTotalPaise, latest && `${latest.debitTotalPaise} vs ${latest.creditTotalPaise}`);
  check('running balance matches the live balance', latest && latest.thisAccount.runningBalancePaise === hist.body.account.balancePaise && hist.body.account.balancePaise === 449750, latest && String(latest.thisAccount.runningBalancePaise));
  check('history lists the deposit too', hist.body.total === 2);
  const otherHist = await api('GET', `/api/ledger/accounts/${accA.id}/transactions`, { token: b.accessToken });
  check("cannot read someone else's history", otherHist.status === 403);
  const otherBal = await api('GET', `/api/ledger/accounts/${accA.id}/balance`, { token: b.accessToken });
  check("cannot read someone else's balance", otherBal.status === 403);

  console.log('\n--- Race-condition demo ---');
  const safe = await api('POST', '/api/demo/race', { token: a.accessToken, body: { mode: 'safe' } });
  check('WITH locking: exactly the affordable number approved', safe.status === 200 && safe.body.verdict === 'CORRECT' && safe.body.approved === safe.body.affordableTransfers && safe.body.finalSourceBalancePaise === 0,
    `approved=${safe.body.approved}/${safe.body.attempts}`);
  const unsafe = await api('POST', '/api/demo/race', { token: a.accessToken, body: { mode: 'unsafe' } });
  check('WITHOUT locking: the account gets overspent', unsafe.status === 200 && unsafe.body.verdict === 'RACE_CONDITION' && unsafe.body.finalSourceBalancePaise < 0,
    `approved=${unsafe.body.approved}/${unsafe.body.attempts}, balance=${unsafe.body.finalSourceBalancePaise}`);
  const badMode = await api('POST', '/api/demo/race', { token: a.accessToken, body: { mode: 'nope' } });
  check('invalid demo mode gives 400', badMode.status === 400);

  console.log('\n--- Admin (RBAC) ---');
  const denied = await api('GET', '/api/ledger/admin/integrity', { token: a.accessToken });
  check('normal user is blocked from admin routes', denied.status === 403);
  await User.update({ role: 'ADMIN' }, { where: { email: emailA } });
  a = (await api('POST', '/api/auth/login', { body: { email: emailA, password: 'pw123456' } })).body;
  const integrity = await api('GET', '/api/ledger/admin/integrity', { token: a.accessToken });
  check('integrity report: books are balanced', integrity.status === 200 && integrity.body.balanced === true,
    `debits=${integrity.body.totalDebitsPaise} credits=${integrity.body.totalCreditsPaise} sumBalances=${integrity.body.sumOfAllBalancesPaise}`);
  const feesBal = await api('GET', '/api/ledger/admin/fees-balance', { token: a.accessToken });
  check('fees balance readable by admin', feesBal.status === 200 && feesBal.body.balancePaise >= 250);
  const adminTx = await api('GET', '/api/ledger/admin/transactions?limit=5', { token: a.accessToken });
  check('admin transaction explorer returns legs', adminTx.status === 200 && adminTx.body.items.length > 0 && adminTx.body.items[0].legs.length >= 2);

  console.log('\n--- Recurring payments ---');
  const sched = await api('POST', '/api/recurring', { token: a.accessToken, key: newKey(), body: { fromAccountId: accA.id, toAccountId: accB.id, amountPaise: 1000, frequency: 'DAILY' } });
  check('schedule created', sched.status === 201);
  const runNow = await api('POST', '/api/recurring/admin/run-due', { token: a.accessToken });
  check('admin can run due payments now', runNow.status === 200 && Array.isArray(runNow.body));
  const cancel = await api('DELETE', `/api/recurring/${sched.body.id}`, { token: a.accessToken });
  check('schedule cancelled', cancel.status === 200 && cancel.body.status === 'CANCELLED');

  console.log('\n--- Logout / token revocation ---');
  const out = await api('POST', '/api/auth/logout', { body: { refreshToken: b.refreshToken } });
  check('logout works from the refresh token alone', out.status === 204);
  const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: b.refreshToken } });
  check('revoked refresh token no longer works', reuse.status === 401);

  console.log(failures === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Smoke test crashed (is the server running?):', err);
  process.exit(1);
});