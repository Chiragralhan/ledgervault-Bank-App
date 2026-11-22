const recurringService = require('../services/recurringService');
const ledgerService = require('../services/ledgerService');
const { storeIdempotentResult } = require('../middleware/idempotency');
const redis = require('../config/redis');

function serialize(s) {
  return {
    id: s.id,
    fromAccountId: s.from_account_id,
    toAccountId: s.to_account_id,
    amountPaise: Number(s.amount_paise),
    frequency: s.frequency,
    nextRunAt: s.next_run_at,
    status: s.status,
    description: s.description,
  };
}

function sendError(err, res) {
  if (err instanceof ledgerService.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof ledgerService.ForbiddenError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof ledgerService.AccountNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Request failed' });
}

// POST /api/recurring - goes through the same Redis idempotency layer as
// transfers, so a double-click can't create two identical schedules.
async function create(req, res) {
  const idempotencyKey = req.idempotencyKey;
  const { fromAccountId, toAccountId, amountPaise, frequency, startAt, description } = req.body;

  try {
    const schedule = await recurringService.createSchedule({
      requestingUser: req.user,
      fromAccountId,
      toAccountId,
      amountPaise,
      frequency,
      startAt,
      description,
    });
    const body = serialize(schedule);
    await storeIdempotentResult(idempotencyKey, 201, body);
    return res.status(201).json(body);
  } catch (err) {
    // Any failure: release the key so the client can fix the request and
    // retry with the same Idempotency-Key.
    await redis.del(idempotencyKey);
    return sendError(err, res);
  }
}

async function list(req, res) {
  try {
    const schedules = await recurringService.listSchedules(req.user);
    res.json(schedules.map(serialize));
  } catch (err) {
    sendError(err, res);
  }
}

async function runs(req, res) {
  try {
    const rows = await recurringService.getRuns(req.params.id, req.user);
    res.json(
      rows.map((r) => ({
        periodKey: r.period_key,
        status: r.status,
        transactionId: r.transaction_id,
        failureReason: r.failure_reason,
        recordedAt: r.createdAt,
      }))
    );
  } catch (err) {
    sendError(err, res);
  }
}

async function cancel(req, res) {
  try {
    const schedule = await recurringService.cancelSchedule(req.params.id, req.user);
    res.json(serialize(schedule));
  } catch (err) {
    sendError(err, res);
  }
}

// POST /api/recurring/admin/run-due - ADMIN: run the due-payments job right
// now instead of waiting for the next minute tick (handy for demos).
async function runDueNow(req, res) {
  try {
    const results = await recurringService.runDueSchedules();
    res.json(results);
  } catch (err) {
    sendError(err, res);
  }
}

module.exports = { create, list, runs, cancel, runDueNow };