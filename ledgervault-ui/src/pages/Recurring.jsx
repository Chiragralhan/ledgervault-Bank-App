import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { api, formatRupees, newIdempotencyKey } from '../api';
import { rupeesToPaise } from '../money';
import Explain from '../components/Explain';

const FREQ_LABEL = { DAILY: 'every day', WEEKLY: 'every week', MONTHLY: 'every month' };

function when(iso) {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- create form ----------
function CreateForm({ accounts, onCreated }) {
  const [fromId, setFromId] = useState(accounts[0] ? accounts[0].id : '');
  const [email, setEmail] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [frequency, setFrequency] = useState('MONTHLY');
  const [startMode, setStartMode] = useState('now'); // 'now' | 'later'
  const [startAt, setStartAt] = useState('');
  const [error, setError] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());

  async function findRecipient(e) {
    e.preventDefault();
    setLookupError('');
    setRecipient(null);
    try {
      const r = await api.get(`/api/ledger/directory?email=${encodeURIComponent(email.trim())}`);
      setRecipient(r);
      setToId(r.accounts[0].id);
    } catch (err) {
      setLookupError(err.message);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const amountPaise = rupeesToPaise(amountText);
    if (!recipient) return setError('Find the recipient first.');
    if (!amountPaise || amountPaise <= 0) return setError('Enter a valid amount.');
    if (startMode === 'later' && !startAt) return setError('Pick the first payment date and time.');

    setBusy(true);
    try {
      await api.post(
        '/api/recurring',
        {
          fromAccountId: fromId,
          toAccountId: toId,
          amountPaise,
          frequency,
          ...(startMode === 'later' ? { startAt: new Date(startAt).toISOString() } : {}),
          description: `To ${recipient.name}`,
        },
        key.current
      );
      key.current = newIdempotencyKey();
      setAmountText('');
      setRecipient(null);
      setEmail('');
      onCreated();
    } catch (err) {
      setError(err.message);
      if (err.status && err.status < 500) key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form">
      <h2>New scheduled payment</h2>
      <label>
        Pay from
        <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountType} · {formatRupees(a.balancePaise)} · …{a.id.slice(-4)}
            </option>
          ))}
        </select>
      </label>

      <div className="lookup">
        <label>
          Recipient's email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="landlord@example.com" />
        </label>
        <button type="button" className="btn" onClick={findRecipient}>
          Find
        </button>
      </div>
      {lookupError && <div className="error">{lookupError}</div>}
      {recipient && (
        <div className="found">
          ✓ Found <b>{recipient.name}</b>
          {recipient.accounts.length > 1 && (
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              {recipient.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountType} · …{a.id.slice(-4)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <label>
        Amount each time (₹)
        <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="100" />
      </label>

      <label>
        How often
        <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
      </label>

      <div>
        <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>First payment</div>
        <div className="row">
          <label className="radio">
            <input type="radio" checked={startMode === 'now'} onChange={() => setStartMode('now')} /> As soon as possible
            (within a minute, good for a demo)
          </label>
          <label className="radio">
            <input type="radio" checked={startMode === 'later'} onChange={() => setStartMode('later')} /> At a chosen time
          </label>
        </div>
        {startMode === 'later' && (
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} style={{ marginTop: 8 }} />
        )}
      </div>

      {error && <div className="error">{error}</div>}
      <button className="btn primary" disabled={busy} onClick={submit}>
        {busy ? 'Saving…' : 'Create schedule'}
      </button>
    </section>
  );
}

// ---------- one schedule + its run history ----------
function ScheduleCard({ s, accounts, onChanged }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seenRuns = useRef(null);

  const loadRuns = useCallback(async () => {
    try {
      const rows = await api.get(`/api/recurring/${s.id}/runs`);
      setRuns(rows);
      // A new payment was recorded: refresh the schedule so "Next payment" moves on.
      if (seenRuns.current !== null && seenRuns.current !== rows.length) onChanged();
      seenRuns.current = rows.length;
    } catch (err) {
      setError(err.message);
    }
  }, [s.id, onChanged]);

  // While the history is open, keep it fresh so a new payment appears by itself.
  useEffect(() => {
    if (!open) return undefined;
    loadRuns();
    const id = setInterval(loadRuns, 5000);
    return () => clearInterval(id);
  }, [open, loadRuns]);

  async function cancel() {
    setBusy(true);
    try {
      await api.del(`/api/recurring/${s.id}`);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const from = accounts.find((a) => a.id === s.fromAccountId);
  const active = s.status === 'ACTIVE';

  return (
    <div className="card sched">
      <div className="sched-head">
        <div>
          <b>{s.description || 'Scheduled payment'}</b>
          <div className="muted small">
            {formatRupees(s.amountPaise)} {FREQ_LABEL[s.frequency]} · from {from ? `${from.accountType.toLowerCase()} …${from.id.slice(-4)}` : '…'}
          </div>
        </div>
        <span className={`status ${s.status.toLowerCase()}`}>{s.status}</span>
      </div>
      {active && <div className="small">Next payment: <b>{when(s.nextRunAt)}</b></div>}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn" onClick={() => setOpen(!open)}>
          {open ? 'Hide history' : 'Payment history'}
        </button>
        {active && (
          <button className="btn ghost" disabled={busy} onClick={cancel}>
            Cancel schedule
          </button>
        )}
      </div>

      {open && (
        <div className="runs">
          {!runs && <div className="muted small">Loading…</div>}
          {runs && runs.length === 0 && (
            <div className="muted small">
              No payments yet. The scheduler checks once a minute, so a payment that is due will show up here within a minute.
            </div>
          )}
          {runs && runs.length > 0 && (
            <table className="stmt">
              <thead>
                <tr><th>Period</th><th>Result</th><th>Details</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <Fragment key={r.periodKey}>
                    <tr>
                      <td className="small">{when(r.periodKey)}</td>
                      <td className={r.status === 'COMPLETED' ? 'in' : 'out'}>{r.status === 'COMPLETED' ? '✓ Paid' : '✗ Failed'}</td>
                      <td className="small">
                        {r.status === 'COMPLETED' ? (
                          <span className="mono">txn {String(r.transactionId).slice(0, 8)}…</span>
                        ) : (
                          r.failureReason
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function Recurring() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState(null);
  const [schedules, setSchedules] = useState(null);
  const [error, setError] = useState('');
  const [adminMsg, setAdminMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [accs, list] = await Promise.all([api.get('/api/ledger/accounts'), api.get('/api/recurring')]);
      setAccounts(accs);
      setSchedules(list);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runDueNow() {
    setAdminMsg('');
    try {
      const results = await api.post('/api/recurring/admin/run-due', {});
      const paid = results.filter((r) => r.outcome === 'COMPLETED').length;
      const failed = results.filter((r) => r.outcome === 'FAILED').length;
      setAdminMsg(`Scheduler ran: ${paid} paid, ${failed} failed, ${results.length - paid - failed} not due or already done.`);
      load();
    } catch (err) {
      setAdminMsg(err.message);
    }
  }

  return (
    <div className="page">
      <div>
        <h1>Recurring payments</h1>
        <p className="muted">Set it once; the bank pays on schedule. Each payment is charged the normal transfer fee.</p>
      </div>

      {error && <div className="error">{error}</div>}

      {accounts && accounts.length === 0 && <div className="card empty">Open an account on the Dashboard first.</div>}
      {accounts && accounts.length > 0 && <CreateForm accounts={accounts} onCreated={load} />}

      {user.role === 'ADMIN' && (
        <section className="card">
          <button className="btn" onClick={runDueNow}>Admin: run due payments now</button>
          {adminMsg && <div className="note">{adminMsg}</div>}
        </section>
      )}

      <h2 style={{ marginTop: 8 }}>Your schedules</h2>
      {schedules && schedules.length === 0 && <div className="card empty">No schedules yet.</div>}
      <div className="stack">
        {schedules && accounts && schedules.map((s) => <ScheduleCard key={s.id} s={s} accounts={accounts} onChanged={load} />)}
      </div>

      <Explain title="How a payment can happen exactly once">
        A background job wakes up <b>every minute</b>, finds schedules whose time has come, and pays each one using
        the same safe transfer as the Send page. Three protections stop it paying twice: (1) each schedule row is
        locked while it is processed (and locked rows are <i>skipped</i>, never waited on), (2) the database has a
        unique rule on <b>(schedule, period)</b>, so the same period can only ever be recorded once, even if the
        job is accidentally run twice or the server crashes and restarts, and (3) the payment and its record are
        saved in one transaction. If a payment fails (say, not enough money), that period is recorded as failed
        and is <i>not</i> retried every minute; the schedule simply moves on to the next period.
      </Explain>
    </div>
  );
}