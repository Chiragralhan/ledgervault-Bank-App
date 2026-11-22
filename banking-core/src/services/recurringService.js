const { Op } = require('sequelize');
const { sequelize, Account, RecurringPayment, RecurringPaymentRun } = require('../models');
const ledgerService = require('./ledgerService');
const { isUuid } = require('../utils/validate');

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];
const MAX_SCHEDULES_PER_TICK = 100;

/**
 * Next due date after `date`. Always computed from the SCHEDULED time, never
 * from "now", so a job that runs a few seconds (or hours) late doesn't make
 * the schedule drift. UTC throughout so server timezone never matters.
 * MONTHLY clamps to the last day of shorter months (Jan 31 -> Feb 28/29).
 */
function addPeriod(date, frequency) {
  const d = new Date(date.getTime());
  if (frequency === 'DAILY') {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (frequency === 'WEEKLY') {
    d.setUTCDate(d.getUTCDate() + 7);
  } else if (frequency === 'MONTHLY') {
    const day = d.getUTCDate();
    d.setUTCDate(1); // avoid overflow (e.g. Jan 31 + 1 month)
    d.setUTCMonth(d.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Create / list / cancel (called from HTTP handlers)
// ---------------------------------------------------------------------------

async function createSchedule({
  requestingUser,
  fromAccountId,
  toAccountId,
  amountPaise,
  frequency,
  startAt,
  description,
}) {
  if (!isUuid(fromAccountId) || !isUuid(toAccountId)) {
    throw new ledgerService.ValidationError('fromAccountId and toAccountId must be valid UUIDs');
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ledgerService.ValidationError('amountPaise must be a positive integer');
  }
  if (!FREQUENCIES.includes(frequency)) {
    throw new ledgerService.ValidationError(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  }
  if (fromAccountId === toAccountId) {
    throw new ledgerService.ValidationError('Cannot schedule a transfer to the same account');
  }

  // First run: startAt if given, else right away. A start time in the past
  // is treated as "now" so we never fire a burst of back-dated payments.
  const now = new Date();
  let firstRun = now;
  if (startAt !== undefined && startAt !== null) {
    firstRun = new Date(startAt);
    if (Number.isNaN(firstRun.getTime())) {
      throw new ledgerService.ValidationError('startAt must be a valid ISO date');
    }
    if (firstRun < now) firstRun = now;
  }

  const fromAccount = await Account.findByPk(fromAccountId);
  const toAccount = await Account.findByPk(toAccountId);
  if (!fromAccount || !toAccount) {
    throw new ledgerService.AccountNotFoundError('One or both accounts do not exist');
  }
  // Only the owner of the source account may schedule payments from it
  // (no admin override: at run time the job acts as this user).
  if (fromAccount.user_id !== requestingUser.id) {
    throw new ledgerService.ForbiddenError('You can only schedule payments from your own account');
  }

  return RecurringPayment.create({
    user_id: requestingUser.id,
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
    amount_paise: amountPaise,
    frequency,
    next_run_at: firstRun,
    description,
  });
}

async function listSchedules(requestingUser) {
  return RecurringPayment.findAll({
    where: { user_id: requestingUser.id },
    order: [['createdAt', 'DESC']],
  });
}

async function getRuns(scheduleId, requestingUser) {
  if (!isUuid(scheduleId)) {
    throw new ledgerService.ValidationError('id must be a valid UUID');
  }
  const schedule = await RecurringPayment.findByPk(scheduleId);
  if (!schedule) throw new ledgerService.AccountNotFoundError('Schedule does not exist');
  if (schedule.user_id !== requestingUser.id && requestingUser.role !== 'ADMIN') {
    throw new ledgerService.ForbiddenError('You do not have permission to view this schedule');
  }
  return RecurringPaymentRun.findAll({
    where: { recurring_payment_id: scheduleId },
    order: [['createdAt', 'DESC']],
  });
}

async function cancelSchedule(scheduleId, requestingUser) {
  if (!isUuid(scheduleId)) {
    throw new ledgerService.ValidationError('id must be a valid UUID');
  }
  return sequelize.transaction(async (t) => {
    // Lock the row so a cancel can't interleave with the job mid-payment.
    const schedule = await RecurringPayment.findByPk(scheduleId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!schedule) throw new ledgerService.AccountNotFoundError('Schedule does not exist');
    if (schedule.user_id !== requestingUser.id && requestingUser.role !== 'ADMIN') {
      throw new ledgerService.ForbiddenError('You do not have permission to cancel this schedule');
    }
    schedule.status = 'CANCELLED';
    await schedule.save({ transaction: t });
    return schedule;
  });
}

// ---------------------------------------------------------------------------
// The job: pay every schedule that is due
// ---------------------------------------------------------------------------

function isExpectedFailure(err) {
  return (
    err instanceof ledgerService.InsufficientBalanceError ||
    err instanceof ledgerService.AccountNotFoundError ||
    err instanceof ledgerService.ForbiddenError ||
    err instanceof ledgerService.ValidationError
  );
}

async function advance(schedule, t) {
  schedule.next_run_at = addPeriod(schedule.next_run_at, schedule.frequency);
  await schedule.save({ transaction: t });
}

/**
 * Handle ONE due schedule in ONE database transaction:
 *   1. lock the schedule row (SKIP LOCKED: if another job instance already
 *      holds it, we simply skip it instead of waiting)
 *   2. if this period already has a run row -> don't pay again, just advance
 *   3. otherwise move the money (same fee + locking code as a normal
 *      transfer), write the run row, advance next_run_at
 * Commit makes all of that visible together; any error rolls ALL of it
 * back, so "money moved but period not recorded" can never exist.
 */
async function processSchedule(scheduleId, now) {
  try {
    return await sequelize.transaction(async (t) => {
      const schedule = await RecurringPayment.findOne({
        where: { id: scheduleId },
        transaction: t,
        lock: t.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!schedule) return { scheduleId, outcome: 'SKIPPED_LOCKED' };
      if (schedule.status !== 'ACTIVE' || schedule.next_run_at > now) {
        return { scheduleId, outcome: 'NOT_DUE' };
      }

      const periodKey = schedule.next_run_at.toISOString();

      const alreadyRan = await RecurringPaymentRun.findOne({
        where: { recurring_payment_id: schedule.id, period_key: periodKey },
        transaction: t,
      });
      if (alreadyRan) {
        await advance(schedule, t);
        return { scheduleId, outcome: 'ALREADY_RAN', periodKey };
      }

      // Act as the schedule's owner with role USER, so the normal
      // method-level ownership check still applies to scheduled payments.
      const result = await ledgerService.transferWithFee({
        fromAccountId: schedule.from_account_id,
        toAccountId: schedule.to_account_id,
        amountPaise: Number(schedule.amount_paise), // BIGINT comes back as a string
        requestingUser: { id: schedule.user_id, role: 'USER' },
        description: schedule.description || 'Recurring payment',
        transactionType: 'RECURRING',
        dbTransaction: t,
      });

      await RecurringPaymentRun.create(
        {
          recurring_payment_id: schedule.id,
          period_key: periodKey,
          status: 'COMPLETED',
          transaction_id: result.transactionId,
        },
        { transaction: t }
      );

      await advance(schedule, t);
      return { scheduleId, outcome: 'COMPLETED', periodKey, transactionId: result.transactionId };
    });
  } catch (err) {
    if (isExpectedFailure(err)) {
      return recordFailure(scheduleId, now, err);
    }
    // Unexpected (e.g. database hiccup): nothing was committed, so the next
    // tick simply retries this period - and the unique run row guarantees
    // that retry can never double-pay.
    console.error(`[recurring] schedule ${scheduleId} errored:`, err);
    return { scheduleId, outcome: 'ERROR' };
  }
}

/**
 * The payment itself rolled back (e.g. insufficient balance). Record that
 * this period FAILED and move on, in a fresh transaction - otherwise the
 * job would retry the same doomed payment every minute forever.
 */
async function recordFailure(scheduleId, now, err) {
  return sequelize.transaction(async (t) => {
    const schedule = await RecurringPayment.findOne({
      where: { id: scheduleId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!schedule || schedule.status !== 'ACTIVE' || schedule.next_run_at > now) {
      return { scheduleId, outcome: 'NOT_DUE' };
    }

    const periodKey = schedule.next_run_at.toISOString();
    const existing = await RecurringPaymentRun.findOne({
      where: { recurring_payment_id: schedule.id, period_key: periodKey },
      transaction: t,
    });
    if (!existing) {
      await RecurringPaymentRun.create(
        {
          recurring_payment_id: schedule.id,
          period_key: periodKey,
          status: 'FAILED',
          failure_reason: String(err.message).slice(0, 250),
        },
        { transaction: t }
      );
    }
    await advance(schedule, t);
    return { scheduleId, outcome: 'FAILED', periodKey, reason: err.message };
  });
}

/**
 * Entry point for the cron job (and the demo script). Finds due schedules
 * and handles each one. One period per schedule per call: if the server was
 * down for 3 days, a DAILY schedule catches up one period per tick rather
 * than firing 3 payments at once.
 */
async function runDueSchedules(now = new Date()) {
  const due = await RecurringPayment.findAll({
    where: { status: 'ACTIVE', next_run_at: { [Op.lte]: now } },
    attributes: ['id'],
    order: [['next_run_at', 'ASC']],
    limit: MAX_SCHEDULES_PER_TICK,
  });

  const results = [];
  for (const { id } of due) {
    results.push(await processSchedule(id, now));
  }
  return results;
}

module.exports = {
  addPeriod,
  createSchedule,
  listSchedules,
  getRuns,
  cancelSchedule,
  runDueSchedules,
};