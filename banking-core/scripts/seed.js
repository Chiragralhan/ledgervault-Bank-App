// Run with: node scripts/seed.js
// Creates two test users with accounts, and funds them via a SYSTEM
// account - NOT by inserting a raw balance. Even "initial funding" has
// to go through the double-entry ledger to keep the books balanced:
// every credit needs a matching debit, with no exceptions.
require('dotenv').config();
const { sequelize, User, Account, Transaction, LedgerEntry } = require('../src/models');

async function seed() {
  await sequelize.sync();

  const alice = await User.create({ name: 'Alice', email: 'alice@example.com', password_hash: 'placeholder' });
  const bob = await User.create({ name: 'Bob', email: 'bob@example.com', password_hash: 'placeholder' });

  const aliceAccount = await Account.create({ user_id: alice.id, account_type: 'SAVINGS' });
  const bobAccount = await Account.create({ user_id: bob.id, account_type: 'SAVINGS' });

  // System account represents "money entering the system from outside"
  // (e.g. a bank deposit). It can go negative - that's expected, since
  // it's the counterparty for all external funding.
  const systemAccount = await Account.create({ user_id: alice.id, account_type: 'SYSTEM' });

  const fundingTxn = await Transaction.create({
    initiated_by: alice.id,
    status: 'COMPLETED',
    type: 'TRANSFER',
    description: 'Initial seed funding',
  });

  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: systemAccount.id, type: 'DEBIT', amount: 1000000 });
  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: aliceAccount.id, type: 'CREDIT', amount: 1000000 }); // ₹10,000

  console.log('Seeded:');
  console.log('Alice account:', aliceAccount.id, '- funded with ₹10,000');
  console.log('Bob account:  ', bobAccount.id, '- ₹0 balance');
  console.log('System account:', systemAccount.id);

  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
