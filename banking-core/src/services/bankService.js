const { sequelize, User, Account, Transaction, LedgerEntry } = require('../models');
const ledgerService = require('./ledgerService');
const { isUuid } = require('../utils/validate');

const BANK_EMAIL = 'bank@internal.system';
const MAX_DEPOSIT_PAISE = 10000000; // ₹1,00,000 per deposit (demo safety cap)

/**
 * The bank itself needs two internal accounts:
 *   FEES    - collects every fee charged on transfers
 *   RESERVE - the counterparty for money entering the system. When a user
 *             deposits ₹1,000, the books record: RESERVE debited ₹1,000,
 *             user credited ₹1,000. RESERVE therefore goes negative by the
 *             total amount deposited - that is expected, and it is what
 *             keeps the double-entry rule (debits == credits) true even for
 *             money coming from outside the system.
 * Created once at startup (and lazily here as a fallback). Single-flight:
 * concurrent callers in one process share one creation attempt.
 */
let bootPromise = null;

async function createSystemAccounts() {
  const [bankUser] = await User.findOrCreate({
    where: { email: BANK_EMAIL },
    defaults: { name: 'Bank (System)', password_hash: 'no-login', role: 'ADMIN' },
  });

  let fees = await Account.findOne({ where: { account_type: 'FEES' } });
  if (!fees) fees = await Account.create({ user_id: bankUser.id, account_type: 'FEES' });

  let reserve = await Account.findOne({ where: { user_id: bankUser.id, account_type: 'SYSTEM' } });
  if (!reserve) reserve = await Account.create({ user_id: bankUser.id, account_type: 'SYSTEM' });

  return { bankUserId: bankUser.id, feesAccountId: fees.id, reserveAccountId: reserve.id };
}

function ensureSystemAccounts() {
  if (!bootPromise) {
    bootPromise = createSystemAccounts().catch((err) => {
      bootPromise = null; // allow a retry next time
      throw err;
    });
  }
  return bootPromise;
}

/**
 * Credit `accountId` from the bank RESERVE inside the caller's DB
 * transaction. No balance check on the reserve (it is allowed to go
 * negative), and no row lock needed: we only ever INSERT rows here, never
 * read-then-decide, so there is no race to protect against.
 */
async function fundAccountInternal({ accountId, amountPaise, ownerUserId, description, dbTransaction }) {
  const { reserveAccountId } = await ensureSystemAccounts();

  const txn = await Transaction.create(
    { initiated_by: ownerUserId, status: 'PENDING', type: 'TRANSFER', description },
    { transaction: dbTransaction }
  );
  await LedgerEntry.create(
    { transaction_id: txn.id, account_id: reserveAccountId, type: 'DEBIT', amount: amountPaise },
    { transaction: dbTransaction }
  );
  await LedgerEntry.create(
    { transaction_id: txn.id, account_id: accountId, type: 'CREDIT', amount: amountPaise },
    { transaction: dbTransaction }
  );
  txn.status = 'COMPLETED';
  await txn.save({ transaction: dbTransaction });
  return txn.id;
}

/**
 * Public deposit ("add money"). Simulated cash-in: there is no real payment
 * gateway, but the ledger entries are exactly what a real deposit would write.
 * Only the account owner can deposit, and only into SAVINGS/CURRENT accounts.
 */
async function deposit({ accountId, amountPaise, requestingUser }) {
  if (!isUuid(accountId)) {
    throw new ledgerService.ValidationError('accountId must be a valid UUID');
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ledgerService.ValidationError('amountPaise must be a positive integer');
  }
  if (amountPaise > MAX_DEPOSIT_PAISE) {
    throw new ledgerService.ValidationError('Maximum deposit per request is ₹1,00,000');
  }

  const account = await Account.findByPk(accountId);
  if (!account) throw new ledgerService.AccountNotFoundError('Account does not exist');
  if (account.user_id !== requestingUser.id) {
    throw new ledgerService.ForbiddenError('You can only deposit into your own account');
  }
  if (!['SAVINGS', 'CURRENT'].includes(account.account_type)) {
    throw new ledgerService.ValidationError('Deposits are only allowed into SAVINGS or CURRENT accounts');
  }

  const transactionId = await sequelize.transaction((t) =>
    fundAccountInternal({
      accountId,
      amountPaise,
      ownerUserId: requestingUser.id,
      description: 'Cash deposit (simulated)',
      dbTransaction: t,
    })
  );
  const balancePaise = await ledgerService.getBalance(accountId);
  return { transactionId, accountId, amountPaise, balancePaise };
}

module.exports = { ensureSystemAccounts, fundAccountInternal, deposit, MAX_DEPOSIT_PAISE, BANK_EMAIL };
