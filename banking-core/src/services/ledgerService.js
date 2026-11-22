const { sequelize, Account, Transaction, LedgerEntry } = require('../models');
const { calculateFee } = require('./feeService');
const { isUuid } = require('../utils/validate');

class InsufficientBalanceError extends Error {}
class AccountNotFoundError extends Error {}
class ForbiddenError extends Error {}
class FeesAccountNotConfiguredError extends Error {}
class ValidationError extends Error {}

/**
 * Balance is NEVER stored - it's calculated by summing ledger entries.
 * SUM(CREDIT) - SUM(DEBIT) for a given account.
 *
 * `dbTransaction` is optional - when passed, this read happens INSIDE
 * that transaction, so the balance we check is the one protected by the
 * row lock, not a separate unprotected read.
 */
async function getBalance(accountId, dbTransaction = null) {
  const result = await LedgerEntry.findOne({
    attributes: [
      [
        sequelize.literal(
          `COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0) -
           COALESCE(SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE 0 END), 0)`
        ),
        'balance',
      ],
    ],
    where: { account_id: accountId },
    raw: true,
    transaction: dbTransaction,
  });

  return Number(result.balance);
}

/**
 * Balance read WITH an ownership check (method-level RBAC).
 * A user can only read balances of accounts they own; ADMIN can read any.
 * Use this from HTTP handlers. Plain getBalance() stays unchecked because
 * it is an internal helper (used inside transfers, tests, scripts).
 */
async function getBalanceForUser(accountId, requestingUser) {
  if (!isUuid(accountId)) {
    throw new ValidationError('accountId must be a valid UUID');
  }
  const account = await Account.findByPk(accountId);
  if (!account) {
    throw new AccountNotFoundError('Account does not exist');
  }
  if (requestingUser.role !== 'ADMIN' && account.user_id !== requestingUser.id) {
    throw new ForbiddenError('You do not have permission to view this account');
  }
  return getBalance(accountId);
}

/**
 * Total fee revenue collected. Only reachable through an admin-only route
 * (route-level RBAC via authorize('ADMIN')).
 */
async function getFeesBalance() {
  const feesAccount = await Account.findOne({ where: { account_type: 'FEES' } });
  if (!feesAccount) {
    throw new FeesAccountNotConfiguredError(
      'No FEES account exists - run scripts/createFeesAccount.js once'
    );
  }
  const balancePaise = await getBalance(feesAccount.id);
  return { feesAccountId: feesAccount.id, balancePaise };
}

// Money is always an integer number of paise. Rejecting floats / strings /
// NaN here means a request like amountPaise: 10.5 or "100" can never reach
// the ledger. Malformed account ids are rejected here too, so they become
// a clean 400 instead of a database error.
function validateTransferInput({ fromAccountId, toAccountId, amountPaise }) {
  if (!isUuid(fromAccountId) || !isUuid(toAccountId)) {
    throw new ValidationError('fromAccountId and toAccountId must be valid UUIDs');
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ValidationError('amountPaise must be a positive integer');
  }
  if (fromAccountId === toAccountId) {
    throw new ValidationError('Cannot transfer to the same account');
  }
}

/**
 * INTERNAL no-fee transfer. It is NOT exposed over HTTP - the only public
 * transfer route charges a fee. It stays in the service because the stress
 * test and internal callers use it directly.
 *
 * Wrapped in one DB transaction: both ledger rows are written or neither.
 * Account rows are locked with SELECT ... FOR UPDATE in sorted-id order
 * (prevents deadlocks between A->B and B->A at the same instant).
 *
 * `requestingUser` ({ id, role } from the verified JWT) drives the
 * method-level RBAC check: only the account owner (or an ADMIN) may
 * transfer FROM an account.
 */
async function transfer({ fromAccountId, toAccountId, amountPaise, requestingUser, description }) {
  validateTransferInput({ fromAccountId, toAccountId, amountPaise });

  return sequelize.transaction(async (dbTransaction) => {
    const [firstId, secondId] = [fromAccountId, toAccountId].sort();

    const firstAccount = await Account.findByPk(firstId, {
      transaction: dbTransaction,
      lock: dbTransaction.LOCK.UPDATE,
    });
    const secondAccount = await Account.findByPk(secondId, {
      transaction: dbTransaction,
      lock: dbTransaction.LOCK.UPDATE,
    });

    const fromAccount = firstId === fromAccountId ? firstAccount : secondAccount;
    const toAccount = firstId === fromAccountId ? secondAccount : firstAccount;

    if (!fromAccount || !toAccount) {
      throw new AccountNotFoundError('One or both accounts do not exist');
    }

    if (
      requestingUser &&
      requestingUser.role !== 'ADMIN' &&
      fromAccount.user_id !== requestingUser.id
    ) {
      throw new ForbiddenError('You do not have permission to transfer from this account');
    }

    const currentBalance = await getBalance(fromAccountId, dbTransaction);
    if (currentBalance < amountPaise) {
      throw new InsufficientBalanceError(
        `Account ${fromAccountId} has insufficient balance`
      );
    }

    const initiatedByUserId = requestingUser ? requestingUser.id : fromAccount.user_id;

    const txnRecord = await Transaction.create(
      {
        initiated_by: initiatedByUserId,
        status: 'PENDING',
        type: 'TRANSFER',
        description,
      },
      { transaction: dbTransaction }
    );

    await LedgerEntry.create(
      { transaction_id: txnRecord.id, account_id: fromAccountId, type: 'DEBIT', amount: amountPaise },
      { transaction: dbTransaction }
    );

    await LedgerEntry.create(
      { transaction_id: txnRecord.id, account_id: toAccountId, type: 'CREDIT', amount: amountPaise },
      { transaction: dbTransaction }
    );

    txnRecord.status = 'COMPLETED';
    await txnRecord.save({ transaction: dbTransaction });

    return { transactionId: txnRecord.id, fromAccountId, toAccountId, amountPaise };
  });
}

/**
 * The body of a fee-charging transfer, run inside a DB transaction that
 * the CALLER owns. Split out so it can run either in its own transaction
 * (normal HTTP transfers) or inside a bigger one (the recurring-payment
 * job, which must commit "money moved" and "this period is recorded as
 * paid" together or not at all).
 */
async function executeTransferWithFee(dbTransaction, args) {
  const {
    fromAccountId,
    toAccountId,
    amountPaise,
    feePaise,
    totalDebitPaise,
    requestingUser,
    description,
    transactionType,
  } = args;

  const [firstId, secondId] = [fromAccountId, toAccountId].sort();

  const firstAccount = await Account.findByPk(firstId, {
    transaction: dbTransaction,
    lock: dbTransaction.LOCK.UPDATE,
  });
  const secondAccount = await Account.findByPk(secondId, {
    transaction: dbTransaction,
    lock: dbTransaction.LOCK.UPDATE,
  });

  const fromAccount = firstId === fromAccountId ? firstAccount : secondAccount;
  const toAccount = firstId === fromAccountId ? secondAccount : firstAccount;

  if (!fromAccount || !toAccount) {
    throw new AccountNotFoundError('One or both accounts do not exist');
  }

  if (
    requestingUser &&
    requestingUser.role !== 'ADMIN' &&
    fromAccount.user_id !== requestingUser.id
  ) {
    throw new ForbiddenError('You do not have permission to transfer from this account');
  }

  const feesAccount = await Account.findOne({
    where: { account_type: 'FEES' },
    transaction: dbTransaction,
  });
  if (!feesAccount) {
    throw new FeesAccountNotConfiguredError(
      'No FEES account exists - run scripts/createFeesAccount.js once'
    );
  }

  const currentBalance = await getBalance(fromAccountId, dbTransaction);
  if (currentBalance < totalDebitPaise) {
    throw new InsufficientBalanceError(
      `Account ${fromAccountId} has insufficient balance to cover amount + fee`
    );
  }

  const initiatedByUserId = requestingUser ? requestingUser.id : fromAccount.user_id;

  const txnRecord = await Transaction.create(
    {
      initiated_by: initiatedByUserId,
      status: 'PENDING',
      type: transactionType,
      description,
    },
    { transaction: dbTransaction }
  );

  await LedgerEntry.create(
    { transaction_id: txnRecord.id, account_id: fromAccountId, type: 'DEBIT', amount: totalDebitPaise },
    { transaction: dbTransaction }
  );

  await LedgerEntry.create(
    { transaction_id: txnRecord.id, account_id: toAccountId, type: 'CREDIT', amount: amountPaise },
    { transaction: dbTransaction }
  );

  await LedgerEntry.create(
    { transaction_id: txnRecord.id, account_id: feesAccount.id, type: 'CREDIT', amount: feePaise },
    { transaction: dbTransaction }
  );

  txnRecord.status = 'COMPLETED';
  await txnRecord.save({ transaction: dbTransaction });

  return {
    transactionId: txnRecord.id,
    fromAccountId,
    toAccountId,
    amountPaise,
    feePaise,
    totalDebitPaise,
  };
}

/**
 * The PUBLIC transfer (POST /api/ledger/transfer, and recurring payments).
 * Same locking + RBAC as transfer(), plus a tiered fee.
 *
 * Money flow for a ₹100 transfer with a ₹1 fee:
 *   - Sender is debited ₹101 (amount + fee)
 *   - Recipient is credited the full ₹100
 *   - The FEES account is credited ₹1
 * Three ledger rows; 101 debit = 100 + 1 credit, so they still net to zero.
 * The FEES account is only ever INSERTed into (never read-then-written to
 * make a decision), so it needs no row lock.
 *
 * `dbTransaction` (optional): pass an existing DB transaction to run
 * inside it instead of opening a new one. `transactionType` labels the
 * transactions row ('TRANSFER' by default, 'RECURRING' for the job).
 */
async function transferWithFee({
  fromAccountId,
  toAccountId,
  amountPaise,
  requestingUser,
  description,
  transactionType = 'TRANSFER',
  dbTransaction = null,
}) {
  validateTransferInput({ fromAccountId, toAccountId, amountPaise });

  const feePaise = calculateFee(amountPaise);
  const totalDebitPaise = amountPaise + feePaise;

  const args = {
    fromAccountId,
    toAccountId,
    amountPaise,
    feePaise,
    totalDebitPaise,
    requestingUser,
    description,
    transactionType,
  };

  if (dbTransaction) {
    return executeTransferWithFee(dbTransaction, args);
  }
  return sequelize.transaction((t) => executeTransferWithFee(t, args));
}

module.exports = {
  getBalance,
  getBalanceForUser,
  getFeesBalance,
  transfer,
  transferWithFee,
  InsufficientBalanceError,
  AccountNotFoundError,
  ForbiddenError,
  FeesAccountNotConfiguredError,
  ValidationError,
};