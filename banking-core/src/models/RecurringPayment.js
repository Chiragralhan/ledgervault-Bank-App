const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// A schedule: "move amount_paise from from_account_id to to_account_id
// every DAILY / WEEKLY / MONTHLY, next due at next_run_at".
// Whether a given period has already been paid is NOT tracked here - that
// lives in recurring_payment_runs (permanent, one row per period).
const RecurringPayment = sequelize.define('RecurringPayment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false },
  from_account_id: { type: DataTypes.UUID, allowNull: false },
  to_account_id: { type: DataTypes.UUID, allowNull: false },
  amount_paise: { type: DataTypes.BIGINT, allowNull: false, validate: { min: 1 } },
  frequency: { type: DataTypes.ENUM('DAILY', 'WEEKLY', 'MONTHLY'), allowNull: false },
  next_run_at: { type: DataTypes.DATE, allowNull: false },
  status: { type: DataTypes.ENUM('ACTIVE', 'CANCELLED'), allowNull: false, defaultValue: 'ACTIVE' },
  description: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: 'recurring_payments',
  timestamps: true,
});

module.exports = RecurringPayment;
