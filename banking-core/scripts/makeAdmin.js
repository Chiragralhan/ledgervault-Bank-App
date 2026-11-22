// Run with: node scripts/makeAdmin.js <email>
// Promotes an existing user to ADMIN. This is the ONLY way to get an
// admin - public registration can never create one.
require('dotenv').config();
const { sequelize, User } = require('../src/models');

async function run() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/makeAdmin.js <email>');
    process.exit(1);
  }
  await sequelize.sync();
  const user = await User.findOne({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  user.role = 'ADMIN';
  await user.save();
  console.log(`${email} is now ADMIN. Log in again to get a token with the new role.`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });