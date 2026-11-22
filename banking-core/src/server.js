require('dotenv').config();
const app = require('./app');
const { sequelize } = require('./models');
const { startRecurringPaymentJob } = require('./jobs/recurringPaymentJob');
const { ensureSystemAccounts } = require('./services/bankService');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await sequelize.authenticate();
    console.log('Postgres connection established.');

    // For local dev only. In a real project you'd use migrations
    // (sequelize-cli) instead of sync() so schema changes are tracked.
    await sequelize.sync();
    console.log('Models synced.');

    // The bank's own FEES and RESERVE accounts - created automatically
    // if they don't exist yet (no manual script needed any more).
    await ensureSystemAccounts();
    console.log('Bank system accounts ready.');

    startRecurringPaymentJob();

    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();