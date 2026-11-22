const sequelize = require('../config/database');
const User = require('./User');
const Account = require('./Account');
const Transaction = require('./Transaction');
const LedgerEntry = require('./LedgerEntry');
const RecurringPayment = require('./RecurringPayment');
const RecurringPaymentRun = require('./RecurringPaymentRun');

// A user can own multiple accounts
User.hasMany(Account, { foreignKey: 'user_id' });
Account.belongsTo(User, { foreignKey: 'user_id' });

// A transaction has its ledger entries (2 for a plain transfer, 3 with a fee)
Transaction.hasMany(LedgerEntry, { foreignKey: 'transaction_id' });
LedgerEntry.belongsTo(Transaction, { foreignKey: 'transaction_id' });

// An account has many ledger entries over its lifetime
Account.hasMany(LedgerEntry, { foreignKey: 'account_id' });
LedgerEntry.belongsTo(Account, { foreignKey: 'account_id' });

// A user initiates many transactions
User.hasMany(Transaction, { foreignKey: 'initiated_by' });
Transaction.belongsTo(User, { foreignKey: 'initiated_by' });

// A user owns many recurring-payment schedules
User.hasMany(RecurringPayment, { foreignKey: 'user_id' });
RecurringPayment.belongsTo(User, { foreignKey: 'user_id' });

// A schedule has one run row per period it has handled
RecurringPayment.hasMany(RecurringPaymentRun, { foreignKey: 'recurring_payment_id' });
RecurringPaymentRun.belongsTo(RecurringPayment, { foreignKey: 'recurring_payment_id' });

module.exports = {
  sequelize,
  User,
  Account,
  Transaction,
  LedgerEntry,
  RecurringPayment,
  RecurringPaymentRun,
};