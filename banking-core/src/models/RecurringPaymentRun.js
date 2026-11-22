const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One row per (schedule, period) that has been handled - either paid
// (COMPLETED) or given up on (FAILED, e.g. insufficient balance).
// Append-only, like the ledger.
//
// THE KEY LINE is the unique index on (recurring_payment_id, period_key).
// period_key is the scheduled time of the period (ISO string), not "now",
// so retries of the same period always produce the same key. The database
// itself then refuses a second row for that period, which is what makes it
// impossible to pay the same period twice - no matter how many times the
// job fires, crashes, or runs on multiple servers.
const RecurringPaymentRun = sequelize.define('RecurringPaymentRun', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  recurring_payment_id: { type: DataTypes.UUID, allowNull: false },
  period_key: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.ENUM('COMPLETED', 'FAILED'), allowNull: false },
  transaction_id: { type: DataTypes.UUID, allowNull: true }, // set when COMPLETED
  failure_reason: { type: DataTypes.STRING, allowNull: true }, // set when FAILED
}, {
  tableName: 'recurring_payment_runs',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { unique: true, name: 'uniq_schedule_period', fields: ['recurring_payment_id', 'period_key'] },
  ],
});

module.exports = RecurringPaymentRun;