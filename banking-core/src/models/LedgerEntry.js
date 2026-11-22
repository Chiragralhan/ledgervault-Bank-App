const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// THE CORE TABLE. Rows here are NEVER updated or deleted - only inserted.
// Every transfer creates exactly two rows (one DEBIT, one CREDIT) that
// must net to zero. An account's balance is never stored directly - it's
// always calculated as SUM(CREDIT amounts) - SUM(DEBIT amounts) for that
// account_id. This is what makes the ledger tamper-evident and auditable.
const LedgerEntry = sequelize.define('LedgerEntry', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  transaction_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  account_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM('DEBIT', 'CREDIT'),
    allowNull: false,
  },
  // Stored as an integer in the smallest currency unit (paise for INR).
  // Never use FLOAT/DECIMAL-as-JS-number for money - floating point
  // rounding errors are exactly the kind of bug this project exists to avoid.
  amount: {
    type: DataTypes.BIGINT,
    allowNull: false,
    validate: { min: 1 }, // amount must always be positive; direction is set by `type`
  },
}, {
  tableName: 'ledger_entries',
  timestamps: true,
  updatedAt: false, // rows are append-only - there is no such thing as "updating" a ledger entry
});

module.exports = LedgerEntry;
