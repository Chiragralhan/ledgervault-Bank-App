const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Account = sequelize.define('Account', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  account_type: {
    type: DataTypes.ENUM('SAVINGS', 'CURRENT', 'SYSTEM', 'FEES'),
    allowNull: false,
    defaultValue: 'SAVINGS',
  },
  currency: {
    type: DataTypes.STRING(3),
    allowNull: false,
    defaultValue: 'INR',
  },
}, {
  tableName: 'accounts',
  timestamps: true,
});

module.exports = Account;