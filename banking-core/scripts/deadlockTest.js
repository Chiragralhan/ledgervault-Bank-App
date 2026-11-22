// Run with: node scripts/deadlockTest.js
//
// PROVES that LedgerVault cannot deadlock when two people pay each other
// at the same time (A -> B and B -> A).
//
// What is a deadlock? Transfer 1 locks account A and then waits for B.
// Transfer 2 locks account B and then waits for A. Each holds what the
// other needs, so both wait forever. Postgres notices after about a second
// and kills one of them with error 40P01 ("deadlock detected").
//
// The test runs the same traffic twice:
//   PHASE 1 - a naive transfer that locks accounts in the order given
//             (from-account first). Deadlocks are EXPECTED here.
//   PHASE 2 - the real ledgerService.transfer(), which always locks the
//             lower account id first. Deadlocks must be ZERO.
// Then it checks that no money was created or lost.
require('dotenv').config();
const { sequelize, User, Account, Transaction, LedgerEntry } = require('../src/models');
const ledgerService = require('../src/services/ledgerService');

const PAIRS = Number(process.env.PAIRS || 100); // each pair = one A->B and one B->A at the same time
const NAIVE_PAIRS = Number(process.env.NAIVE_PAIRS || 25);
const A_TO_B = 1000; // ₹10.00
const B_TO_A = 700; //  ₹7.00 (different on purpose, so the expected final balances are not simply "unchanged")
const START_BALANCE = 10000000; // ₹1,00,000 each, far more than needed: nothing can fail for lack of money

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDeadlock = (err) =>
  (err && err.original && err.original.code === '40P01') || /deadlock detected/i.test((err && err.message) || '');

// The "obvious" implementation: lock the from-account, then the to-account.
async function naiveTransfer(fromId, toId, amount, userId) {
  return sequelize.transaction(async (t) => {
    await Account.findByPk(fromId, { transaction: t, lock: t.LOCK.UPDATE }); // lock #1: whichever was passed first
    await sleep(5); // a few ms of "real work" (validation, checks) between the two locks
    await Account.findByPk(toId, { transaction: t, lock: t.LOCK.UPDATE }); //   lock #2
    const txn = await Transaction.create(
      { initiated_by: userId, status: 'PENDING', type: 'TRANSFER', description: 'deadlock test (naive)' },
      { transaction: t }
    );
    await LedgerEntry.create({ transaction_id: txn.id, account_id: fromId, type: 'DEBIT', amount }, { transaction: t });
    await LedgerEntry.create({ transaction_id: txn.id, account_id: toId, type: 'CREDIT', amount }, { transaction: t });
    txn.status = 'COMPLETED';
    await txn.save({ transaction: t });
  });
}

async function makeAccounts(label) {
  const user = await User.create({ name: `Deadlock ${label}`, email: `dl${label}${Date.now()}@example.com`, password_hash: 'x' });
  const a = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const b = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const bank = await Account.create({ user_id: user.id, account_type: 'SYSTEM' });
  const fund = await Transaction.create({ initiated_by: user.id, status: 'COMPLETED', type: 'TRANSFER', description: 'deadlock test funding' });
  for (const acct of [a, b]) {
    await LedgerEntry.create({ transaction_id: fund.id, account_id: bank.id, type: 'DEBIT', amount: START_BALANCE });
    await LedgerEntry.create({ transaction_id: fund.id, account_id: acct.id, type: 'CREDIT', amount: START_BALANCE });
  }
  return { user, a, b };
}

async function fire(pairs, send) {
  const jobs = [];
  for (let i = 0; i < pairs; i += 1) {
    jobs.push(send('AtoB'));
    jobs.push(send('BtoA'));
  }
  const started = Date.now();
  const results = await Promise.allSettled(jobs);
  return {
    results,
    ms: Date.now() - started,
    ok: results.filter((r) => r.status === 'fulfilled').length,
    deadlocks: results.filter((r) => r.status === 'rejected' && isDeadlock(r.reason)).length,
    otherErrors: results.filter((r) => r.status === 'rejected' && !isDeadlock(r.reason)).length,
  };
}

async function run() {
  await sequelize.sync();
  let failed = false;
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? '✅ PASS' : '❌ FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed = true;
  };

  // ---------------- PHASE 1: naive ----------------
  console.log(`\nPHASE 1 - NAIVE locking (from-account first): ${NAIVE_PAIRS * 2} transfers, A->B and B->A at the same instant`);
  const n = await makeAccounts('naive');
  const naive = await fire(NAIVE_PAIRS, (dir) =>
    dir === 'AtoB' ? naiveTransfer(n.a.id, n.b.id, A_TO_B, n.user.id) : naiveTransfer(n.b.id, n.a.id, B_TO_A, n.user.id)
  );
  console.log(`  finished in ${(naive.ms / 1000).toFixed(1)}s: ${naive.ok} succeeded, ${naive.deadlocks} killed by Postgres as DEADLOCKS, ${naive.otherErrors} other errors`);
  console.log(naive.deadlocks > 0
    ? '  -> Deadlocks happened, exactly as the theory says. (Postgres rescued us by killing one side of each, but those payments FAILED.)'
    : '  -> No deadlock this time (timing is random). Re-run, or raise NAIVE_PAIRS.');

  // ---------------- PHASE 2: LedgerVault ----------------
  console.log(`\nPHASE 2 - LEDGERVAULT locking (lowest account id first): ${PAIRS * 2} transfers, A->B and B->A at the same instant`);
  const s = await makeAccounts('safe');
  const safe = await fire(PAIRS, (dir) =>
    dir === 'AtoB'
      ? ledgerService.transfer({ fromAccountId: s.a.id, toAccountId: s.b.id, amountPaise: A_TO_B, requestingUser: { id: s.user.id, role: 'USER' }, description: 'deadlock test (safe)' })
      : ledgerService.transfer({ fromAccountId: s.b.id, toAccountId: s.a.id, amountPaise: B_TO_A, requestingUser: { id: s.user.id, role: 'USER' }, description: 'deadlock test (safe)' })
  );
  console.log(`  finished in ${(safe.ms / 1000).toFixed(1)}s: ${safe.ok} succeeded, ${safe.deadlocks} deadlocks, ${safe.otherErrors} other errors\n`);

  check('zero deadlocks with sorted lock ordering', safe.deadlocks === 0, `${safe.deadlocks} deadlocks`);
  check('every transfer succeeded', safe.ok === PAIRS * 2 && safe.otherErrors === 0, `${safe.ok}/${PAIRS * 2}`);

  const balA = await ledgerService.getBalance(s.a.id);
  const balB = await ledgerService.getBalance(s.b.id);
  const expectedA = START_BALANCE - PAIRS * A_TO_B + PAIRS * B_TO_A;
  const expectedB = START_BALANCE + PAIRS * A_TO_B - PAIRS * B_TO_A;
  check('account A has exactly the expected balance', balA === expectedA, `${balA} vs ${expectedA}`);
  check('account B has exactly the expected balance', balB === expectedB, `${balB} vs ${expectedB}`);
  check('no money created or lost (A + B unchanged)', balA + balB === 2 * START_BALANCE);

  const naiveBalSum = (await ledgerService.getBalance(n.a.id)) + (await ledgerService.getBalance(n.b.id));
  check('even the naive phase lost no money (failed transfers rolled back completely)', naiveBalSum === 2 * START_BALANCE, `${naiveBalSum}`);

  console.log(failed ? '\n❌ DEADLOCK TEST FAILED' : '\n✅ DEADLOCK TEST PASSED');
  await sequelize.close();
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});