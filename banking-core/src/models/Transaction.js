const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// This is metadata ABOUT a transfer (status, who did it, why).
// It does NOT hold money movement itself - that lives in ledger_entries.
// Keeping this separate means the ledger table stays minimal and untouched
// while this table can evolve freely (add fields, statuses, etc).
const Transaction = sequelize.define('Transaction', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  initiated_by: {
    type: DataTypes.UUID,
    allowNull: false, // user_id of who triggered this
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'COMPLETED', 'FAILED'),
    allowNull: false,
    defaultValue: 'PENDING',
  },
  type: {
    type: DataTypes.ENUM('TRANSFER', 'FEE', 'RECURRING'),
    allowNull: false,
    defaultValue: 'TRANSFER',
  },
  description: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'transactions',
  timestamps: true,
});

module.exports = Transaction;
