// Run with: node scripts/createAccountForUser.js <email>
// Creates a SAVINGS account for an already-registered user (via
// /api/auth/register) and funds it with ₹5,000 from a SYSTEM account,
// the same pattern as seed.js. Use this to get a real account you can
// actually log in as and transfer from, to test Step 5's auth end-to-end.
require('dotenv').config();
const { sequelize, User, Account, Transaction, LedgerEntry } = require('../src/models');

async function run() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/createAccountForUser.js <email>');
    process.exit(1);
  }

  await sequelize.sync();

  const user = await User.findOne({ where: { email } });
  if (!user) {
    console.error(`No user found with email ${email}. Register them first via POST /api/auth/register.`);
    process.exit(1);
  }

  const account = await Account.create({ user_id: user.id, account_type: 'SAVINGS' });
  const systemAccount = await Account.create({ user_id: user.id, account_type: 'SYSTEM' });

  const fundingAmount = 500000; // ₹5,000
  const fundingTxn = await Transaction.create({
    initiated_by: user.id,
    status: 'COMPLETED',
    type: 'TRANSFER',
    description: 'Test account funding',
  });
  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: systemAccount.id, type: 'DEBIT', amount: fundingAmount });
  await LedgerEntry.create({ transaction_id: fundingTxn.id, account_id: account.id, type: 'CREDIT', amount: fundingAmount });

  console.log(`Account created for ${email}:`);
  console.log('Account ID:', account.id, '- funded with ₹5,000');

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});