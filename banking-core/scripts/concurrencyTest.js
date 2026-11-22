// Run with: node scripts/concurrencyTest.js
// Fires many transfers OUT of the same account at the exact same time.
// Before Step 3 (no locking), some of these could "win the race" and
// read a stale balance - letting the account go negative, or letting
// more money leave than actually existed. With locking in place, they
// queue up safely and the final balance is always exactly correct.
require('dotenv').config();
const { sequelize, Account, User, Transaction, LedgerEntry } = require('../src/models');
const ledgerService = require('../src/services/ledgerService');

const CONCURRENT_TRANSFERS = 20;
const AMOUNT_PER_TRANSFER = 10000; // ₹100 each

async function run() {
  await sequelize.sync();

  const user = await User.create({ name: 'StressTest', email: `stress${Date.now()}@example.com`, password_hash: 'x' });
  const source = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const sink = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const system = await Account.create({ user_id: user.id, account_type: 'SYSTEM' });

  // Fund `source` directly via ledger entries (bypassing transfer()'s
  // balance check, same as seed.js) - a fresh SYSTEM account has 0
  // balance, so it can't "afford" its own funding transfer through the
  // normal path.
  const fundingAmount = AMOUNT_PER_TRANSFER * 10; // enough for exactly 10 transfers
  const fundingTxn = await Transaction.create({
    initiated_by: user.id,
    status: 'COMPLETED',
    type: 'TRANSFER',
    description: 'stress test funding',
  });
  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: system.id, type: 'DEBIT', amount: fundingAmount });
  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: source.id, type: 'CREDIT', amount: fundingAmount });

  console.log(`Firing ${CONCURRENT_TRANSFERS} concurrent transfers of ₹${AMOUNT_PER_TRANSFER / 100} each...`);
  console.log(`Account funded with ₹${fundingAmount / 100} - exactly ${fundingAmount / AMOUNT_PER_TRANSFER} should succeed.\n`);

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT_TRANSFERS }).map(() =>
      ledgerService.transfer({
        fromAccountId: source.id,
        toAccountId: sink.id,
        amountPaise: AMOUNT_PER_TRANSFER,
        initiatedBy: user.id,
        description: 'concurrent stress transfer',
      })
    )
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  const finalSourceBalance = await ledgerService.getBalance(source.id);
  const finalSinkBalance = await ledgerService.getBalance(sink.id);

  console.log(`Succeeded: ${succeeded}, Failed (insufficient balance): ${failed}`);
  console.log(`Final source balance: ₹${finalSourceBalance / 100}`);
  console.log(`Final sink balance:   ₹${finalSinkBalance / 100}`);

  const expectedSuccesses = fundingAmount / AMOUNT_PER_TRANSFER;
  if (succeeded === expectedSuccesses && finalSourceBalance === 0) {
    console.log('\n✅ PASS - exactly the right number of transfers succeeded, no race condition.');
  } else {
    console.log('\n❌ FAIL - numbers do not match expectations, check locking logic.');
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});