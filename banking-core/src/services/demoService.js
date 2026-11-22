const { sequelize, Account, Transaction, LedgerEntry } = require('../models');
const ledgerService = require('./ledgerService');
const bankService = require('./bankService');

const NAIVE_DELAY_MS = 25; // simulated time between "check balance" and "write" (fraud check, network call...)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * THE BUG THIS PROJECT EXISTS TO PREVENT, written the naive way:
 *   1. read the balance          (no lock)
 *   2. if it is enough, write the debit/credit rows
 * Between step 1 and step 2 other requests do the same thing. If 20 requests
 * all read "balance = 10 payments' worth" before any of them writes, all 20
 * approve themselves - the account is overspent. The small delay stands in
 * for the real-world gap (validation, fraud checks, network calls) that makes
 * this happen in production. Only the demo uses this function.
 */
async function naiveTransfer({ fromAccountId, toAccountId, amountPaise, userId }) {
  const seenBalancePaise = await ledgerService.getBalance(fromAccountId); // READ, no lock
  await sleep(NAIVE_DELAY_MS);

  if (seenBalancePaise < amountPaise) {
    const err = new ledgerService.InsufficientBalanceError('Insufficient balance');
    err.seenBalancePaise = seenBalancePaise;
    throw err;
  }

  await sequelize.transaction(async (t) => {
    const txn = await Transaction.create(
      { initiated_by: userId, status: 'PENDING', type: 'TRANSFER', description: 'race demo (NO locking)' },
      { transaction: t }
    );
    await LedgerEntry.create(
      { transaction_id: txn.id, account_id: fromAccountId, type: 'DEBIT', amount: amountPaise },
      { transaction: t }
    );
    await LedgerEntry.create(
      { transaction_id: txn.id, account_id: toAccountId, type: 'CREDIT', amount: amountPaise },
      { transaction: t }
    );
    txn.status = 'COMPLETED';
    await txn.save({ transaction: t });
  });

  return { seenBalancePaise };
}

function intInRange(value, fallback, min, max, name) {
  const n = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ledgerService.ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * Fires `attempts` transfers at the same instant out of an account that can
 * afford only `affordable` of them, then reports what happened.
 *   mode "safe"   -> the real ledgerService.transfer(): row locks, sorted order
 *   mode "unsafe" -> naiveTransfer() above: no locks
 * Uses two throw-away sandbox accounts owned by the caller (type SYSTEM, so
 * they never show up in the user's account list) funded from the bank
 * reserve, so the user's real balances are never touched. The ledger stays
 * balanced either way - what breaks in unsafe mode is the overdraft rule.
 */
async function runRace(requestingUser, body = {}) {
  const mode = body.mode;
  if (mode !== 'safe' && mode !== 'unsafe') {
    throw new ledgerService.ValidationError('mode must be "safe" or "unsafe"');
  }
  const attempts = intInRange(body.attempts, 20, 2, 40, 'attempts');
  const amountPaise = intInRange(body.amountPaise, 10000, 100, 100000, 'amountPaise');
  const affordable = intInRange(body.affordable, Math.floor(attempts / 2), 1, attempts - 1, 'affordable');
  const fundedPaise = amountPaise * affordable;

  // --- set up two sandbox accounts and fund the source ---
  const { source, sink } = await sequelize.transaction(async (t) => {
    const src = await Account.create({ user_id: requestingUser.id, account_type: 'SYSTEM' }, { transaction: t });
    const snk = await Account.create({ user_id: requestingUser.id, account_type: 'SYSTEM' }, { transaction: t });
    await bankService.fundAccountInternal({
      accountId: src.id,
      amountPaise: fundedPaise,
      ownerUserId: requestingUser.id,
      description: 'race demo sandbox funding',
      dbTransaction: t,
    });
    return { source: src, sink: snk };
  });

  // --- the race ---
  const startedAt = Date.now();
  const attemptLog = await Promise.all(
    Array.from({ length: attempts }, async (_, i) => {
      try {
        const extra =
          mode === 'safe'
            ? await ledgerService
                .transfer({
                  fromAccountId: source.id,
                  toAccountId: sink.id,
                  amountPaise,
                  requestingUser,
                  description: 'race demo (with locking)',
                })
                .then(() => ({}))
            : await naiveTransfer({
                fromAccountId: source.id,
                toAccountId: sink.id,
                amountPaise,
                userId: requestingUser.id,
              });
        return { attempt: i + 1, outcome: 'APPROVED', finishedAtMs: Date.now() - startedAt, ...extra };
      } catch (err) {
        if (err instanceof ledgerService.InsufficientBalanceError) {
          return {
            attempt: i + 1,
            outcome: 'REJECTED',
            finishedAtMs: Date.now() - startedAt,
            seenBalancePaise: err.seenBalancePaise,
          };
        }
        console.error('[demo race] unexpected error:', err);
        return { attempt: i + 1, outcome: 'ERROR', finishedAtMs: Date.now() - startedAt };
      }
    })
  );
  attemptLog.sort((a, b) => a.finishedAtMs - b.finishedAtMs);

  const approved = attemptLog.filter((a) => a.outcome === 'APPROVED').length;
  const rejected = attemptLog.filter((a) => a.outcome === 'REJECTED').length;
  const errors = attemptLog.filter((a) => a.outcome === 'ERROR').length;
  const finalSourceBalancePaise = await ledgerService.getBalance(source.id);
  const finalSinkBalancePaise = await ledgerService.getBalance(sink.id);
  const overspentPaise = Math.max(0, -finalSourceBalancePaise);
  const raceDetected = finalSourceBalancePaise < 0 || approved > affordable;

  let explanation;
  if (raceDetected) {
    explanation =
      `${approved} transfers were approved but the account could only afford ${affordable}. ` +
      `Every request read the balance before any of them had written, so each one saw enough money. ` +
      `The account is overspent by ₹${(overspentPaise / 100).toFixed(2)}.`;
  } else if (mode === 'safe') {
    explanation =
      `Exactly ${approved} of ${attempts} transfers were approved - the number the account could afford. ` +
      `Row locks made the requests line up one at a time, so each one saw the true, current balance.`;
  } else {
    explanation =
      'No overspend happened this time - the requests did not overlap enough. Run it again; the naive version fails when requests overlap.';
  }

  return {
    mode,
    attempts,
    amountPaise,
    fundedPaise,
    affordableTransfers: affordable,
    approved,
    rejected,
    errors,
    finalSourceBalancePaise,
    finalSinkBalancePaise,
    overspentPaise,
    verdict: raceDetected ? 'RACE_CONDITION' : 'CORRECT',
    explanation,
    sandbox: { sourceAccountId: source.id, sinkAccountId: sink.id },
    attemptLog,
  };
}

module.exports = { runRace };