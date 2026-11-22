const accountService = require('../services/accountService');
const bankService = require('../services/bankService');
const ledgerService = require('../services/ledgerService');
const { FEE_TIERS, MIN_FEE_PAISE } = require('../services/feeService');
const { storeIdempotentResult } = require('../middleware/idempotency');
const { sendError } = require('../utils/httpErrors');
const redis = require('../config/redis');

// GET /api/ledger/accounts - my accounts with balances
async function list(req, res) {
  try {
    res.json(await accountService.listAccounts(req.user));
  } catch (err) {
    sendError(err, res);
  }
}

// POST /api/ledger/accounts - open a new account (idempotent: a double-click
// can't open two accounts)
async function create(req, res) {
  const idempotencyKey = req.idempotencyKey;
  try {
    const account = await accountService.createAccount(req.user, req.body.accountType);
    await storeIdempotentResult(idempotencyKey, 201, account);
    res.status(201).json(account);
  } catch (err) {
    await redis.del(idempotencyKey);
    sendError(err, res);
  }
}

// POST /api/ledger/accounts/:accountId/deposit - simulated cash-in
async function deposit(req, res) {
  const idempotencyKey = req.idempotencyKey;
  try {
    const result = await bankService.deposit({
      accountId: req.params.accountId,
      amountPaise: req.body.amountPaise,
      requestingUser: req.user,
    });
    await storeIdempotentResult(idempotencyKey, 201, result);
    res.status(201).json(result);
  } catch (err) {
    await redis.del(idempotencyKey);
    sendError(err, res);
  }
}

// GET /api/ledger/accounts/:accountId/transactions?limit=&offset=
async function history(req, res) {
  try {
    const result = await accountService.getAccountHistory(req.params.accountId, req.user, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(result);
  } catch (err) {
    sendError(err, res);
  }
}

// GET /api/ledger/directory?email= - who am I sending to?
async function lookup(req, res) {
  try {
    res.json(await accountService.lookupRecipient(req.query.email));
  } catch (err) {
    sendError(err, res);
  }
}

// GET /api/ledger/fee-quote?amountPaise= - live fee preview while typing a transfer
function feeQuote(req, res) {
  const amountPaise = Number(req.query.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return res.status(400).json({ error: 'amountPaise must be a positive integer' });
  }
  const tier = FEE_TIERS.find((t) => amountPaise <= t.maxAmountPaise);
  const rawFeePaise = Math.round((amountPaise * tier.feeBasisPoints) / 10000);
  const feePaise = Math.max(rawFeePaise, MIN_FEE_PAISE);
  res.json({
    amountPaise,
    feePaise,
    totalDebitPaise: amountPaise + feePaise,
    feeBasisPoints: tier.feeBasisPoints,
    minimumFeeApplied: rawFeePaise < MIN_FEE_PAISE,
  });
}

module.exports = { list, create, deposit, history, lookup, feeQuote };