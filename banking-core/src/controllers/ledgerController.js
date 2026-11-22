const ledgerService = require('../services/ledgerService');
const { storeIdempotentResult } = require('../middleware/idempotency');
const redis = require('../config/redis');

// Shared error handling for the transfer endpoint.
//
// Idempotency rule of thumb:
//  - Outcomes that will NOT change on retry (insufficient balance, account
//    not found) are cached under the key, so a retry gets the same answer.
//  - Errors caused by the request itself (validation, forbidden) or by
//    server problems are NOT cached: we delete the key so the client can
//    fix the request and retry with the same key instead of being stuck
//    behind a stale "processing" claim for 30 seconds.
async function handleTransferErrors(err, idempotencyKey, res) {
  if (err instanceof ledgerService.ValidationError) {
    await redis.del(idempotencyKey);
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof ledgerService.ForbiddenError) {
    await redis.del(idempotencyKey);
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof ledgerService.InsufficientBalanceError) {
    const body = { error: err.message };
    await storeIdempotentResult(idempotencyKey, 400, body);
    return res.status(400).json(body);
  }
  if (err instanceof ledgerService.AccountNotFoundError) {
    const body = { error: err.message };
    await storeIdempotentResult(idempotencyKey, 404, body);
    return res.status(404).json(body);
  }
  if (err instanceof ledgerService.FeesAccountNotConfiguredError) {
    await redis.del(idempotencyKey);
    return res.status(500).json({ error: err.message });
  }

  await redis.del(idempotencyKey);
  console.error(err);
  return res.status(500).json({ error: 'Transfer failed' });
}

// POST /api/ledger/transfer - the ONLY public transfer route, and it
// always charges the tiered fee.
async function transferFunds(req, res) {
  const { fromAccountId, toAccountId, amountPaise, description } = req.body;
  const idempotencyKey = req.idempotencyKey;

  try {
    const result = await ledgerService.transferWithFee({
      fromAccountId,
      toAccountId,
      amountPaise,
      requestingUser: req.user,
      description,
    });

    await storeIdempotentResult(idempotencyKey, 201, result);
    res.status(201).json(result);
  } catch (err) {
    return handleTransferErrors(err, idempotencyKey, res);
  }
}

// GET /api/ledger/accounts/:accountId/balance - owner or ADMIN only.
async function getAccountBalance(req, res) {
  try {
    const balance = await ledgerService.getBalanceForUser(req.params.accountId, req.user);
    res.json({ accountId: req.params.accountId, balancePaise: balance });
  } catch (err) {
    if (err instanceof ledgerService.ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ledgerService.AccountNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ledgerService.ForbiddenError) {
      return res.status(403).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not fetch balance' });
  }
}

// GET /api/ledger/admin/fees-balance - ADMIN only.
async function getFeesBalance(req, res) {
  try {
    const result = await ledgerService.getFeesBalance();
    res.json(result);
  } catch (err) {
    if (err instanceof ledgerService.FeesAccountNotConfiguredError) {
      return res.status(500).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not fetch fees balance' });
  }
}

module.exports = { transferFunds, getAccountBalance, getFeesBalance };