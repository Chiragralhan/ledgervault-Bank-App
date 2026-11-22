require('dotenv').config();
const { Sequelize } = require('sequelize');

// Single Sequelize instance shared across the whole app.
// dialect: 'postgres' is the only Postgres-specific line here -
// everything else (models, queries, transactions) stays the same
// as it would with MySQL.
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false, // set to console.log while debugging to see raw SQL
  }
);

module.exports = sequelize;
