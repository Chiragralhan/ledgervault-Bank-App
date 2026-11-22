// Run with: node scripts/createFeesAccount.js
// Creates ONE global FEES account that collects fee revenue from every
// fee-charged transfer. Safe to re-run - if a FEES account already
// exists, it just prints the existing one instead of creating a
// duplicate.
require('dotenv').config();
const { sequelize, User, Account } = require('../src/models');

async function run() {
  await sequelize.sync();

  const existing = await Account.findOne({ where: { account_type: 'FEES' } });
  if (existing) {
    console.log('FEES account already exists:', existing.id);
    process.exit(0);
  }

  const [bankUser] = await User.findOrCreate({
    where: { email: 'bank@internal.system' },
    defaults: { name: 'Bank (System)', password_hash: 'no-login', role: 'ADMIN' },
  });

  const feesAccount = await Account.create({ user_id: bankUser.id, account_type: 'FEES' });
  console.log('FEES account created:', feesAccount.id);

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});