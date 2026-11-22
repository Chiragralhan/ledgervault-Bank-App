const { Op, QueryTypes } = require('sequelize');
const { sequelize, User, Account, Transaction, LedgerEntry } = require('../models');
const ledgerService = require('./ledgerService');
const { BANK_EMAIL } = require('./bankService');
const { isUuid } = require('../utils/validate');

const USER_ACCOUNT_TYPES = ['SAVINGS', 'CURRENT'];
const MAX_ACCOUNTS_PER_USER = 5;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** The user's own SAVINGS/CURRENT accounts with live balances (one query for all balances). */
async function listAccounts(requestingUser) {
  const accounts = await Account.findAll({
    where: { user_id: requestingUser.id, account_type: { [Op.in]: USER_ACCOUNT_TYPES } },
    order: [['createdAt', 'ASC']],
  });
  if (accounts.length === 0) return [];

  const rows = await sequelize.query(
    `SELECT account_id,
            COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0) AS balance
       FROM ledger_entries
      WHERE account_id IN (:ids)
      GROUP BY account_id`,
    { replacements: { ids: accounts.map((a) => a.id) }, type: QueryTypes.SELECT }
  );
  const balances = new Map(rows.map((r) => [r.account_id, Number(r.balance)]));

  return accounts.map((a) => ({
    id: a.id,
    accountType: a.account_type,
    currency: a.currency,
    balancePaise: balances.get(a.id) || 0,
    createdAt: a.createdAt,
  }));
}

async function createAccount(requestingUser, accountType) {
  if (!USER_ACCOUNT_TYPES.includes(accountType)) {
    throw new ledgerService.ValidationError(`accountType must be one of ${USER_ACCOUNT_TYPES.join(', ')}`);
  }
  const existing = await Account.count({
    where: { user_id: requestingUser.id, account_type: { [Op.in]: USER_ACCOUNT_TYPES } },
  });
  if (existing >= MAX_ACCOUNTS_PER_USER) {
    throw new ledgerService.ValidationError(`You can have at most ${MAX_ACCOUNTS_PER_USER} accounts`);
  }
  const account = await Account.create({ user_id: requestingUser.id, account_type: accountType });
  return {
    id: account.id,
    accountType: account.account_type,
    currency: account.currency,
    balancePaise: 0,
    createdAt: account.createdAt,
  };
}

/**
 * Find who to send money to by exact email (like entering a UPI id or phone
 * number in a payments app). Returns only the name and their personal
 * account ids - no balances, no other details.
 */
async function lookupRecipient(email) {
  if (typeof email !== 'string' || email.trim().length < 3 || email.length > 254) {
    throw new ledgerService.ValidationError('A valid email is required');
  }
  const wanted = email.trim().toLowerCase();
  if (wanted === BANK_EMAIL) {
    throw new ledgerService.AccountNotFoundError('No user found with that email');
  }
  const user = await User.findOne({
    where: sequelize.where(sequelize.fn('lower', sequelize.col('email')), wanted),
  });
  if (!user) throw new ledgerService.AccountNotFoundError('No user found with that email');

  const accounts = await Account.findAll({
    where: { user_id: user.id, account_type: { [Op.in]: USER_ACCOUNT_TYPES } },
    order: [['createdAt', 'ASC']],
  });
  if (accounts.length === 0) {
    throw new ledgerService.AccountNotFoundError('That user has no accounts to receive money yet');
  }
  return {
    name: user.name,
    accounts: accounts.map((a) => ({ id: a.id, accountType: a.account_type })),
  };
}

// ---------------------------------------------------------------------------
// Transaction history, with the full double-entry picture
// ---------------------------------------------------------------------------

function legLabel(account) {
  if (!account) return { label: 'Unknown account', kind: 'USER' };
  if (account.account_type === 'FEES') return { label: 'Bank fee account', kind: 'FEES' };
  const ownerName = account.User ? account.User.name : 'Unknown';
  if (account.account_type === 'SYSTEM') {
    return ownerName === 'Bank (System)'
      ? { label: 'Bank reserve (cash in)', kind: 'RESERVE' }
      : { label: 'System / sandbox account', kind: 'SYSTEM' };
  }
  return { label: `${ownerName} (${account.account_type.toLowerCase()})`, kind: 'USER' };
}

/**
 * For each transaction id, load the transaction AND every one of its ledger
 * rows ("legs") with readable labels. This is what lets the UI show that a
 * transfer is really: one DEBIT leg + one or two CREDIT legs that net to zero.
 */
async function loadTransactionsWithLegs(ids) {
  const map = new Map();
  if (ids.length === 0) return map;

  const txns = await Transaction.findAll({
    where: { id: { [Op.in]: ids } },
    include: [
      {
        model: LedgerEntry,
        include: [{ model: Account, include: [{ model: User, attributes: ['name'] }] }],
      },
    ],
  });

  for (const t of txns) {
    const legs = (t.LedgerEntries || []).map((e) => {
      const { label, kind } = legLabel(e.Account);
      return {
        accountId: e.account_id,
        label,
        kind,
        direction: e.type,
        amountPaise: Number(e.amount),
      };
    });
    // DEBIT legs first, then CREDIT legs, biggest first
    legs.sort((a, b) =>
      a.direction === b.direction ? b.amountPaise - a.amountPaise : a.direction === 'DEBIT' ? -1 : 1
    );
    map.set(t.id, {
      transactionId: t.id,
      type: t.type,
      status: t.status,
      description: t.description,
      createdAt: t.createdAt,
      legs,
      debitTotalPaise: legs.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountPaise, 0),
      creditTotalPaise: legs.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountPaise, 0),
    });
  }
  return map;
}

/**
 * Statement for one account, newest first, with a running balance after each
 * row and every transaction's full set of legs. Owner or ADMIN only.
 */
async function getAccountHistory(accountId, requestingUser, { limit = 20, offset = 0 } = {}) {
  if (!isUuid(accountId)) {
    throw new ledgerService.ValidationError('accountId must be a valid UUID');
  }
  const account = await Account.findByPk(accountId);
  if (!account) throw new ledgerService.AccountNotFoundError('Account does not exist');
  if (requestingUser.role !== 'ADMIN' && account.user_id !== requestingUser.id) {
    throw new ledgerService.ForbiddenError('You do not have permission to view this account');
  }

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  // The window function computes the running balance over the account's WHOLE
  // history (oldest to newest) before we cut out the requested page.
  const rows = await sequelize.query(
    `SELECT transaction_id, type, amount, "createdAt", running_balance
       FROM (
         SELECT le.transaction_id, le.type, le.amount, le."createdAt",
                SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END)
                  OVER (ORDER BY le."createdAt", le.id) AS running_balance
           FROM ledger_entries le
          WHERE le.account_id = :accountId
       ) x
      ORDER BY "createdAt" DESC
      LIMIT :limit OFFSET :offset`,
    { replacements: { accountId, limit: safeLimit, offset: safeOffset }, type: QueryTypes.SELECT }
  );
  const [{ count }] = await sequelize.query(
    'SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = :accountId',
    { replacements: { accountId }, type: QueryTypes.SELECT }
  );

  const txnMap = await loadTransactionsWithLegs(rows.map((r) => r.transaction_id));
  const balancePaise = await ledgerService.getBalance(accountId);

  return {
    account: { id: account.id, accountType: account.account_type, balancePaise },
    total: Number(count),
    limit: safeLimit,
    offset: safeOffset,
    items: rows.map((r) => {
      const txn = txnMap.get(r.transaction_id);
      return {
        ...txn,
        thisAccount: {
          direction: r.type,
          amountPaise: Number(r.amount),
          runningBalancePaise: Number(r.running_balance),
        },
        legs: txn.legs.map((l) => ({ ...l, isThisAccount: l.accountId === accountId })),
      };
    }),
  };
}

module.exports = {
  listAccounts,
  createAccount,
  lookupRecipient,
  getAccountHistory,
  loadTransactionsWithLegs,
  USER_ACCOUNT_TYPES,
};