const cron = require('node-cron');
const { runDueSchedules } = require('../services/recurringService');

// Runs every minute. If a run ever takes longer than a minute and two ticks
// overlap (or you run several server instances), that's safe: each schedule
// row is locked with SKIP LOCKED, and each period can only be recorded once.
function startRecurringPaymentJob() {
  cron.schedule('* * * * *', async () => {
    try {
      const results = await runDueSchedules();
      const interesting = results.filter((r) => r.outcome !== 'NOT_DUE' && r.outcome !== 'SKIPPED_LOCKED');
      if (interesting.length) {
        console.log('[recurring]', interesting.map((r) => `${r.scheduleId}:${r.outcome}`).join(', '));
      }
    } catch (err) {
      console.error('[recurring] job tick failed:', err);
    }
  });
  console.log('Recurring payment job scheduled (every minute).');
}

module.exports = { startRecurringPaymentJob };