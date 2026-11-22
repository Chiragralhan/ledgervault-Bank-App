const { QueryTypes } = require('sequelize');
const { sequelize, Transaction } = require('../models');
const { loadTransactionsWithLegs } = require('./accountService');

/**
 * "Are the books balanced?" - the proof behind double-entry bookkeeping.
 *
 * Every transaction must have debits == credits, so across the whole ledger
 * total debits must equal total credits, AND the balances of all accounts
 * (customers + fee account + bank reserve) must add up to exactly zero.
 * The bank reserve is negative by exactly the amount of money deposited,
 * mirrored by customer balances + collected fees being positive.
 */
async function getIntegrityReport() {
  const [totals] = await sequelize.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'DEBIT'  THEN amount ELSE 0 END), 0) AS debits,
            COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credits,
            COUNT(*) AS entries,
            COUNT(DISTINCT transaction_id) AS transactions
       FROM ledger_entries`,
    { type: QueryTypes.SELECT }
  );

  const unbalanced = await sequelize.query(
    `SELECT transaction_id,
            SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE -amount END) AS difference
       FROM ledger_entries
      GROUP BY transaction_id
     HAVING SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE -amount END) <> 0
      LIMIT 20`,
    { type: QueryTypes.SELECT }
  );

  const byType = await sequelize.query(
    `SELECT a.account_type,
            COUNT(DISTINCT a.id) AS accounts,
            COALESCE(SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0) AS balance
       FROM accounts a
       LEFT JOIN ledger_entries le ON le.account_id = a.id
      GROUP BY a.account_type
      ORDER BY a.account_type`,
    { type: QueryTypes.SELECT }
  );

  const balancesByType = byType.map((r) => ({
    accountType: r.account_type,
    accounts: Number(r.accounts),
    balancePaise: Number(r.balance),
  }));
  const sumOfAllBalancesPaise = balancesByType.reduce((s, r) => s + r.balancePaise, 0);
  const totalDebitsPaise = Number(totals.debits);
  const totalCreditsPaise = Number(totals.credits);

  return {
    balanced: totalDebitsPaise === totalCreditsPaise && unbalanced.length === 0 && sumOfAllBalancesPaise === 0,
    totalDebitsPaise,
    totalCreditsPaise,
    ledgerEntryCount: Number(totals.entries),
    transactionCount: Number(totals.transactions),
    unbalancedTransactions: unbalanced.map((u) => ({
      transactionId: u.transaction_id,
      differencePaise: Number(u.difference),
    })),
    balancesByType,
    sumOfAllBalancesPaise,
  };
}

/** Latest transactions across the whole bank, each with all its debit/credit legs. */
async function getRecentTransactions({ limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const [rows, total] = await Promise.all([
    Transaction.findAll({
      attributes: ['id'],
      order: [['createdAt', 'DESC']],
      limit: safeLimit,
      offset: safeOffset,
    }),
    Transaction.count(),
  ]);

  const map = await loadTransactionsWithLegs(rows.map((r) => r.id));
  return {
    total,
    limit: safeLimit,
    offset: safeOffset,
    items: rows.map((r) => map.get(r.id)).filter(Boolean),
  };
}

module.exports = { getIntegrityReport, getRecentTransactions };