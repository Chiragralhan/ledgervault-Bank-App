// Run with: node scripts/failurePathTests.js     (the server must be running: npm run dev)
//
// The "happy path" tests prove the app works when people behave. This file
// proves it stays SAFE when they don't: wrong passwords, stolen or expired
// tokens, normal users poking at admin routes, someone else's accounts,
// bad amounts, retried requests, not enough money.
// For every attack it checks two things: (1) the right error code comes
// back, and (2) NO MONEY MOVED.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { User } = require('../src/models');

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
let failures = 0;
let total = 0;
let keyCounter = 0;
const newKey = () => `fail-${Date.now()}-${keyCounter++}`;

function check(label, ok, detail = '') {
  total += 1;
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
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json };
}

async function newUser(label) {
  const email = `${label}${Date.now()}${Math.floor(Math.random() * 1000)}@fail.test`;
  await api('POST', '/api/auth/register', { body: { name: label, email, password: 'pw123456' } });
  const login = (await api('POST', '/api/auth/login', { body: { email, password: 'pw123456' } })).body;
  const account = (await api('POST', '/api/ledger/accounts', { token: login.accessToken, key: newKey(), body: { accountType: 'SAVINGS' } })).body;
  return { email, ...login, account };
}

async function balanceOf(user, accountId) {
  const r = await api('GET', `/api/ledger/accounts/${accountId}/balance`, { token: user.accessToken });
  return r.body.balancePaise;
}

async function deposit(user, amountPaise) {
  return api('POST', `/api/ledger/accounts/${user.account.id}/deposit`, { token: user.accessToken, key: newKey(), body: { amountPaise } });
}

async function run() {
  const alice = await newUser('alice');
  const bob = await newUser('bob');
  const mallory = await newUser('mallory'); // the attacker
  await deposit(alice, 100000); // ₹1,000
  const startA = await balanceOf(alice, alice.account.id);
  const startB = await balanceOf(bob, bob.account.id);
  const transfer = (user, body, key = newKey()) => api('POST', '/api/ledger/transfer', { token: user.accessToken, key, body });

  // =====================================================================
  console.log('\n--- 1. Login and registration abuse ---');
  const wrongPw = await api('POST', '/api/auth/login', { body: { email: alice.email, password: 'wrong-password' } });
  const noUser = await api('POST', '/api/auth/login', { body: { email: 'nobody@fail.test', password: 'whatever1' } });
  check('wrong password is rejected (401)', wrongPw.status === 401);
  check('unknown email gives the SAME error as a wrong password (no user enumeration)', noUser.status === 401 && noUser.body.error === wrongPw.body.error, wrongPw.body.error);
  const dupe = await api('POST', '/api/auth/register', { body: { name: 'x', email: alice.email, password: 'pw123456' } });
  check('registering an existing email is rejected (409)', dupe.status === 409);
  const missing = await api('POST', '/api/auth/register', { body: { email: 'a@b.c' } });
  check('registration with missing fields is rejected (400)', missing.status === 400);
  const sneaky = `sneaky${Date.now()}@fail.test`;
  const sneakyReg = await api('POST', '/api/auth/register', { body: { name: 'Sneaky', email: sneaky, password: 'pw123456', role: 'ADMIN' } });
  check('cannot register yourself as ADMIN (role in body is ignored)', sneakyReg.status === 201 && sneakyReg.body.role === 'USER', sneakyReg.body.role);

  // =====================================================================
  console.log('\n--- 2. Bad, expired, forged and stolen tokens ---');
  const noToken = await api('GET', '/api/ledger/accounts');
  check('no token at all -> 401', noToken.status === 401);
  const junk = await api('GET', '/api/ledger/accounts', { token: 'not.a.token' });
  check('garbage token -> 401', junk.status === 401);
  const expired = jwt.sign({ sub: alice.account.user_id || 'x', role: 'USER' }, process.env.JWT_ACCESS_SECRET, { expiresIn: -30 });
  const expiredRes = await api('GET', '/api/ledger/accounts', { token: expired });
  check('EXPIRED access token -> 401', expiredRes.status === 401);
  const forgedAdmin = jwt.sign({ sub: 'x', role: 'ADMIN' }, 'attacker-guessed-secret', { expiresIn: '15m' });
  const forgedRes = await api('GET', '/api/ledger/admin/integrity', { token: forgedAdmin });
  check('forged ADMIN token (signed with the wrong secret) -> 401', forgedRes.status === 401);
  const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x","role":"ADMIN"}').toString('base64url')}.`;
  const noneRes = await api('GET', '/api/ledger/admin/integrity', { token: noneAlg });
  check('unsigned token ("alg: none" trick) -> 401', noneRes.status === 401);
  const refreshAsAccess = await api('GET', '/api/ledger/accounts', { token: alice.refreshToken });
  check('a refresh token cannot be used as an access token -> 401', refreshAsAccess.status === 401);
  const accessAsRefresh = await api('POST', '/api/auth/refresh', { body: { refreshToken: alice.accessToken } });
  check('an access token cannot be used to refresh -> rejected', accessAsRefresh.status === 401 || accessAsRefresh.status === 400, String(accessAsRefresh.status));
  const garbageRefresh = await api('POST', '/api/auth/refresh', { body: { refreshToken: 'garbage' } });
  check('garbage refresh token -> rejected', garbageRefresh.status === 401 || garbageRefresh.status === 400, String(garbageRefresh.status));

  // =====================================================================
  console.log('\n--- 3. Refresh-token rotation and revocation ---');
  const carol = await newUser('carol');
  const r1 = carol.refreshToken;
  const rot = await api('POST', '/api/auth/refresh', { body: { refreshToken: r1 } });
  check('refresh works once and returns a new pair', rot.status === 200 && !!rot.body.refreshToken && rot.body.refreshToken !== r1);
  const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: r1 } });
  check('the OLD refresh token is dead after rotation (replay blocked)', reuse.status === 401);
  await api('POST', '/api/auth/logout', { body: { refreshToken: rot.body.refreshToken } });
  const afterLogout = await api('POST', '/api/auth/refresh', { body: { refreshToken: rot.body.refreshToken } });
  check('after logout the refresh token is revoked immediately', afterLogout.status === 401);

  // =====================================================================
  console.log('\n--- 4. Role-based access control ---');
  for (const [label, method, path] of [
    ['integrity report', 'GET', '/api/ledger/admin/integrity'],
    ['fees balance', 'GET', '/api/ledger/admin/fees-balance'],
    ['all transactions', 'GET', '/api/ledger/admin/transactions'],
    ['run due payments', 'POST', '/api/recurring/admin/run-due'],
  ]) {
    const r = await api(method, path, { token: mallory.accessToken, body: method === 'POST' ? {} : undefined });
    check(`a normal user is blocked from admin: ${label} -> 403`, r.status === 403, String(r.status));
  }

  // =====================================================================
  console.log("\n--- 5. Touching someone else's money ---");
  const bal = await api('GET', `/api/ledger/accounts/${alice.account.id}/balance`, { token: mallory.accessToken });
  check("cannot read another user's balance -> 403", bal.status === 403);
  const stmt = await api('GET', `/api/ledger/accounts/${alice.account.id}/transactions`, { token: mallory.accessToken });
  check("cannot read another user's statement -> 403", stmt.status === 403);
  const steal = await transfer(mallory, { fromAccountId: alice.account.id, toAccountId: mallory.account.id, amountPaise: 50000 });
  check("cannot transfer OUT of another user's account -> 403", steal.status === 403);
  const dep = await api('POST', `/api/ledger/accounts/${alice.account.id}/deposit`, { token: mallory.accessToken, key: newKey(), body: { amountPaise: 100 } });
  check("cannot deposit into another user's account -> 403", dep.status === 403);
  const sched = await api('POST', '/api/recurring', { token: alice.accessToken, key: newKey(), body: { fromAccountId: alice.account.id, toAccountId: bob.account.id, amountPaise: 100, frequency: 'MONTHLY', startAt: new Date(Date.now() + 86400000 * 30).toISOString() } });
  const cancel = await api('DELETE', `/api/recurring/${sched.body.id}`, { token: mallory.accessToken });
  check("cannot cancel someone else's recurring payment -> 403", cancel.status === 403);
  const schedFrom = await api('POST', '/api/recurring', { token: mallory.accessToken, key: newKey(), body: { fromAccountId: alice.account.id, toAccountId: mallory.account.id, amountPaise: 100, frequency: 'DAILY' } });
  check("cannot schedule payments OUT of someone else's account -> 403", schedFrom.status === 403);
  check('after all those attacks, Alice still has exactly her money', (await balanceOf(alice, alice.account.id)) === startA);

  // =====================================================================
  console.log('\n--- 6. Bad input to the transfer endpoint ---');
  const base = { fromAccountId: alice.account.id, toAccountId: bob.account.id };
  const bad = [
    ['negative amount', { ...base, amountPaise: -500 }],
    ['zero amount', { ...base, amountPaise: 0 }],
    ['decimal amount (10.5 paise)', { ...base, amountPaise: 10.5 }],
    ['amount sent as a string', { ...base, amountPaise: '500' }],
    ['missing amount', { ...base }],
    ['sending to the same account', { fromAccountId: alice.account.id, toAccountId: alice.account.id, amountPaise: 500 }],
    ['account id that is not a UUID', { fromAccountId: 'abc', toAccountId: bob.account.id, amountPaise: 500 }],
  ];
  for (const [label, body] of bad) {
    const r = await transfer(alice, body);
    check(`${label} -> 400`, r.status === 400, String(r.status));
  }
  const ghost = await transfer(alice, { fromAccountId: alice.account.id, toAccountId: '11111111-1111-4111-8111-111111111111', amountPaise: 500 });
  check('sending to an account that does not exist -> 404', ghost.status === 404, String(ghost.status));
  const noKey = await api('POST', '/api/ledger/transfer', { token: alice.accessToken, body: { ...base, amountPaise: 500 } });
  check('missing Idempotency-Key header -> 400', noKey.status === 400);
  check('none of the bad requests moved any money', (await balanceOf(alice, alice.account.id)) === startA && (await balanceOf(bob, bob.account.id)) === startB);

  // =====================================================================
  console.log('\n--- 7. Not enough money ---');
  const tooMuch = await transfer(alice, { ...base, amountPaise: 500000 });
  check('sending more than the balance -> 400', tooMuch.status === 400, tooMuch.body.error);
  const exactly = await transfer(alice, { ...base, amountPaise: startA }); // enough for the amount, NOT for amount + fee
  check('balance covers the amount but NOT the fee -> 400 (fee is counted)', exactly.status === 400, String(exactly.status));
  check('balances unchanged after the rejected transfers', (await balanceOf(alice, alice.account.id)) === startA && (await balanceOf(bob, bob.account.id)) === startB);

  // =====================================================================
  console.log('\n--- 8. Retries and double-clicks (idempotency) ---');
  // Ask the server what a ₹100 transfer costs in total (amount + fee), so the
  // test doesn't hard-code the fee rules.
  const quote = (await api('GET', '/api/ledger/fee-quote?amountPaise=10000', { token: alice.accessToken })).body;
  const cost = quote.totalDebitPaise;
  const k1 = newKey();
  const first = await transfer(alice, { ...base, amountPaise: 10000 }, k1);
  const second = await transfer(alice, { ...base, amountPaise: 10000 }, k1);
  check('same Idempotency-Key twice returns the SAME transaction', first.status === 201 && second.body.transactionId === first.body.transactionId);
  const afterRetry = await balanceOf(alice, alice.account.id);
  check(`...and Alice was charged only ONCE (₹100 + fee = ${cost} paise)`, afterRetry === startA - cost, `${startA - afterRetry} paise taken`);

  const k2 = newKey();
  const burst = await Promise.all(Array.from({ length: 5 }, () => transfer(alice, { ...base, amountPaise: 10000 }, k2)));
  const ids = new Set(burst.filter((r) => r.status === 201).map((r) => r.body.transactionId));
  const statuses = burst.map((r) => r.status).sort().join(',');
  check('5 identical requests at the SAME instant -> only one transfer is created', ids.size === 1, `statuses: ${statuses}`);
  check('...and Alice was charged only once more', (await balanceOf(alice, alice.account.id)) === afterRetry - cost);

  await deposit(mallory, 100000);
  const sharedKey = newKey();
  const aliceUses = await transfer(alice, { ...base, amountPaise: 100 }, sharedKey);
  const malloryUses = await transfer(mallory, { fromAccountId: mallory.account.id, toAccountId: bob.account.id, amountPaise: 100 }, sharedKey);
  check('two users using the same key string never see each other\'s result (keys are per user)', aliceUses.status === 201 && malloryUses.status === 201 && malloryUses.body.transactionId !== aliceUses.body.transactionId, `statuses ${aliceUses.status}/${malloryUses.status}`);

  const poorKey = newKey();
  const poor1 = await transfer(bob, { fromAccountId: bob.account.id, toAccountId: alice.account.id, amountPaise: 900000 }, poorKey);
  await deposit(bob, 2000000);
  const poor2 = await transfer(bob, { fromAccountId: bob.account.id, toAccountId: alice.account.id, amountPaise: 900000 }, poorKey);
  check('a rejected request replayed with the same key gets the same answer (by design)', poor1.status === 400 && poor2.status === 400);
  const poor3 = await transfer(bob, { fromAccountId: bob.account.id, toAccountId: alice.account.id, amountPaise: 900000 }, newKey());
  check('...but a NEW key (a fresh attempt) now succeeds', poor3.status === 201, String(poor3.status));

  // =====================================================================
  console.log('\n--- 9. After everything: the books still balance ---');
  await User.update({ role: 'ADMIN' }, { where: { email: carol.email } });
  const adminLogin = (await api('POST', '/api/auth/login', { body: { email: carol.email, password: 'pw123456' } })).body;
  const integrity = await api('GET', '/api/ledger/admin/integrity', { token: adminLogin.accessToken });
  check('integrity report: debits == credits and all balances sum to 0', integrity.status === 200 && integrity.body.balanced === true,
    `debits=${integrity.body.totalDebitsPaise} credits=${integrity.body.totalCreditsPaise}`);

  console.log(failures === 0 ? `\n✅ ALL ${total} FAILURE-PATH CHECKS PASSED` : `\n❌ ${failures} OF ${total} CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Test crashed (is the server running?):', err);
  process.exit(1);
});