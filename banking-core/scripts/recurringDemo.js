// Run with: node scripts/recurringDemo.js
// Proves the recurring-payment guarantees against the real database:
//   1. Many job runs firing at the SAME time pay a period exactly once
//   2. Replaying an already-paid period moves no money (permanent record)
//   3. A payment that can't be afforded is recorded FAILED, not retried forever
//   4. After all of that, the ledger still balances (debits == credits)
// Requires the FEES account: run `node scripts/createFeesAccount.js` once first.
require('dotenv').config();
const { QueryTypes } = require('sequelize');
const {
  sequelize, User, Account, Transaction, LedgerEntry, RecurringPayment, RecurringPaymentRun,
} = require('../src/models');
const ledgerService = require('../src/services/ledgerService');
const recurringService = require('../src/services/recurringService');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function fund(accountId, systemAccountId, userId, amountPaise) {
  const txn = await Transaction.create({
    initiated_by: userId, status: 'COMPLETED', type: 'TRANSFER', description: 'demo funding',
  });
  await LedgerEntry.create({ transaction_id: txn.id, account_id: systemAccountId, type: 'DEBIT', amount: amountPaise });
  await LedgerEntry.create({ transaction_id: txn.id, account_id: accountId, type: 'CREDIT', amount: amountPaise });
}

async function run() {
  await sequelize.sync();

  const feesAccount = await Account.findOne({ where: { account_type: 'FEES' } });
  if (!feesAccount) {
    console.error('No FEES account. Run: node scripts/createFeesAccount.js');
    process.exit(1);
  }

  // --- setup: a fresh user with ₹10,000, and a recipient ---
  const stamp = Date.now();
  const user = await User.create({ name: 'RecurDemo', email: `recur${stamp}@example.com`, password_hash: 'x' });
  const source = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const sink = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const system = await Account.create({ user_id: user.id, account_type: 'SYSTEM' });
  await fund(source.id, system.id, user.id, 1000000);

  const AMOUNT = 100000; // ₹1,000  -> fee tier 0.50% = 500 paise
  const schedule = await recurringService.createSchedule({
    requestingUser: { id: user.id, role: 'USER' },
    fromAccountId: source.id,
    toAccountId: sink.id,
    amountPaise: AMOUNT,
    frequency: 'DAILY',
    description: 'demo daily payment',
  });

  // Make the first period due a minute ago
  const originalDue = new Date(Date.now() - 60 * 1000);
  schedule.next_run_at = originalDue;
  await schedule.save();

  // --- 1. five job runs at the same instant ---
  console.log('\n[1] Firing 5 job runs concurrently for one due schedule...');
//   const outcomes = (await Promise.all(Array.from({ length: 5 }, () => recurringService.runDueSchedules())))
//     .flat();
    const outcomes = (await Promise.all(Array.from({ length: 5 }, () => recurringService.runDueSchedules())))
    .flat()
    .filter((o) => o.scheduleId === schedule.id); // ignore other schedules in the shared DB
  const completed = outcomes.filter((o) => o.outcome === 'COMPLETED').length;
  console.log('    outcomes:', outcomes.map((o) => o.outcome).join(', '));

  const afterFirst = await ledgerService.getBalance(source.id);
  const runsAfterFirst = await RecurringPaymentRun.count({ where: { recurring_payment_id: schedule.id } });
  await schedule.reload();
  check('exactly one payment happened', completed === 1 && runsAfterFirst === 1, `completed=${completed}, run rows=${runsAfterFirst}`);
  check('sender debited once (amount + fee)', afterFirst === 1000000 - (AMOUNT + 500), `balance=${afterFirst}`);
  check('recipient credited the amount once', (await ledgerService.getBalance(sink.id)) === AMOUNT);
  check('next_run_at advanced by one day',
    schedule.next_run_at.getTime() === recurringService.addPeriod(originalDue, 'DAILY').getTime());

  // --- 2. replay the SAME period (simulates a double-fire / crash recovery) ---
  console.log('\n[2] Replaying the already-paid period...');
  schedule.next_run_at = originalDue;
  await schedule.save();
//   const replay = await recurringService.runDueSchedules();
  const replay = (await recurringService.runDueSchedules()).filter((o) => o.scheduleId === schedule.id);
  console.log('    outcomes:', replay.map((o) => o.outcome).join(', '));
  check('replay was recognised as already paid', replay.length === 1 && replay[0].outcome === 'ALREADY_RAN');
  check('no extra money moved', (await ledgerService.getBalance(source.id)) === afterFirst);

  // --- 3. a payment the account cannot afford ---
  console.log('\n[3] Scheduling a payment larger than the balance...');
  const broke = await recurringService.createSchedule({
    requestingUser: { id: user.id, role: 'USER' },
    fromAccountId: source.id,
    toAccountId: sink.id,
    amountPaise: 99999999,
    frequency: 'DAILY',
  });
  broke.next_run_at = new Date(Date.now() - 60 * 1000);
  await broke.save();
  const failRun = (await recurringService.runDueSchedules()).find((o) => o.scheduleId === broke.id);
  console.log('    outcome:', failRun && failRun.outcome, '-', failRun && failRun.reason);
  const failRow = await RecurringPaymentRun.findOne({ where: { recurring_payment_id: broke.id } });
  check('recorded as FAILED', failRun && failRun.outcome === 'FAILED' && failRow && failRow.status === 'FAILED');
  check('balance unchanged by the failed payment', (await ledgerService.getBalance(source.id)) === afterFirst);
  const again = (await recurringService.runDueSchedules()).find((o) => o.scheduleId === broke.id);
  check('failed period is NOT retried every tick', !again);

  // --- 4. ledger integrity across everything above ---
  console.log('\n[4] Ledger integrity check...');
  const unbalanced = await sequelize.query(
    `SELECT transaction_id
       FROM ledger_entries
      GROUP BY transaction_id
     HAVING SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE -amount END) <> 0`,
    { type: QueryTypes.SELECT }
  );
  check('every transaction has debits == credits', unbalanced.length === 0, `unbalanced=${unbalanced.length}`);

  console.log(failures === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});