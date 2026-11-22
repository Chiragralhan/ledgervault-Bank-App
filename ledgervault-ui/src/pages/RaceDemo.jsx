import { useState } from 'react';
import { api, formatRupees } from '../api';
import Explain from '../components/Explain';

const NAIVE_CODE = `// WITHOUT locking
balance = read balance            // 1. look
if (balance >= amount) {          // 2. decide
  write DEBIT  from account       // 3. act
  write CREDIT to   account
}
// Between step 1 and step 3 other requests
// do the same thing and ALL see the old balance.`;

const SAFE_CODE = `// WITH locking (what LedgerVault does)
BEGIN transaction
  SELECT ... FOR UPDATE            // lock both accounts
  balance = read balance           // nobody else can change it now
  if (balance >= amount) {
    write DEBIT  from account
    write CREDIT to   account
  }
COMMIT                             // lock released
// Other requests wait their turn and then
// see the TRUE, up-to-date balance.`;

// The row of little squares: one per request, in the order they finished.
function Timeline({ log }) {
  return (
    <div className="timeline">
      {log.map((a) => (
        <span
          key={a.attempt}
          className={`sq ${a.outcome.toLowerCase()}`}
          title={
            `Request #${a.attempt}: ${a.outcome}` +
            (a.seenBalancePaise !== undefined ? `\nSaw balance ${formatRupees(a.seenBalancePaise)} when it checked` : '')
          }
        />
      ))}
    </div>
  );
}

function ResultPanel({ title, subtitle, mode, state, onRun, disabled }) {
  const { loading, result, error } = state;

  // In unsafe mode, count how many requests saw the same (stale) balance.
  let staleLine = null;
  if (result && mode === 'unsafe') {
    const counts = {};
    result.attemptLog.forEach((a) => {
      if (a.seenBalancePaise !== undefined) counts[a.seenBalancePaise] = (counts[a.seenBalancePaise] || 0) + 1;
    });
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    if (top && top[1] > result.affordableTransfers) {
      staleLine = `${top[1]} requests all looked at the balance and saw ${formatRupees(Number(top[0]))}, before any of them had spent it.`;
    }
  }

  return (
    <section className={`card race-panel ${mode}`}>
      <h2>{title}</h2>
      <p className="muted small">{subtitle}</p>
      <button className={`btn ${mode === 'safe' ? 'primary' : 'danger'}`} onClick={onRun} disabled={loading || disabled}>
        {loading ? 'Running…' : `Run ${mode === 'safe' ? 'with' : 'without'} locking`}
      </button>
      {error && <div className="error">{error}</div>}

      {result && (
        <>
          <div className={`verdict ${result.verdict === 'CORRECT' ? 'ok' : 'bad'}`}>
            {result.verdict === 'CORRECT' ? '✓ Correct' : '✗ Race condition: account overspent'}
          </div>
          <div className="race-stats">
            <div><span>Approved</span><b>{result.approved} / {result.attempts}</b></div>
            <div><span>Account could afford</span><b>{result.affordableTransfers}</b></div>
            <div>
              <span>Final balance</span>
              <b className={result.finalSourceBalancePaise < 0 ? 'neg' : ''}>{formatRupees(result.finalSourceBalancePaise)}</b>
            </div>
            {result.overspentPaise > 0 && (
              <div><span>Money that never existed</span><b className="neg">{formatRupees(result.overspentPaise)}</b></div>
            )}
          </div>
          <div className="muted small">Requests in the order they finished (hover a square):</div>
          <Timeline log={result.attemptLog} />
          <div className="legend">
            <span><i className="sq approved" /> approved</span>
            <span><i className="sq rejected" /> rejected (not enough money)</span>
          </div>
          {staleLine && <div className="note">{staleLine}</div>}
          <p className="small">{result.explanation}</p>
        </>
      )}
    </section>
  );
}

export default function RaceDemo() {
  const [attempts, setAttempts] = useState(20);
  const [unsafe, setUnsafe] = useState({ loading: false, result: null, error: '' });
  const [safe, setSafe] = useState({ loading: false, result: null, error: '' });

  const affordable = Math.floor(attempts / 2);
  const anyLoading = unsafe.loading || safe.loading;

  async function run(mode) {
    const set = mode === 'safe' ? setSafe : setUnsafe;
    set({ loading: true, result: null, error: '' });
    try {
      // Same setup both times: ₹100 transfers, account funded for exactly half of them.
      const result = await api.post('/api/demo/race', { mode, attempts, amountPaise: 10000, affordable });
      set({ loading: false, result, error: '' });
    } catch (err) {
      set({ loading: false, result: null, error: err.message });
    }
  }

  async function runBoth() {
    await run('unsafe');
    await run('safe');
  }

  return (
    <div className="page">
      <div>
        <h1>The double-spend race</h1>
        <p className="muted">
          What happens when many payments hit the same account at the same instant? Run it both ways.
        </p>
      </div>

      <section className="card">
        <div className="setup">
          <div>
            <b>The setup</b>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              A fresh test account is funded with exactly {formatRupees(affordable * 10000)}, which is enough for{' '}
              <b>{affordable}</b> payments of ₹100. Then <b>{attempts}</b> payments of ₹100 are fired at it{' '}
              <b>at the same instant</b>. A correct system approves exactly {affordable} and rejects the rest.
              (Your real accounts are never touched.)
            </p>
          </div>
          <div className="setup-controls">
            <label className="small muted">
              Simultaneous payments: <b>{attempts}</b>
              <input type="range" min="10" max="40" step="2" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} />
            </label>
            <button className="btn" onClick={runBoth} disabled={anyLoading}>
              Run both, one after the other
            </button>
          </div>
        </div>
      </section>

      <div className="race-grid">
        <ResultPanel
          title="❌ Without locking"
          subtitle="Check the balance, then spend. The obvious way to write it."
          mode="unsafe"
          state={unsafe}
          onRun={() => run('unsafe')}
          disabled={anyLoading}
        />
        <ResultPanel
          title="✅ With locking"
          subtitle="LedgerVault: lock the account row, then check and spend."
          mode="safe"
          state={safe}
          onRun={() => run('safe')}
          disabled={anyLoading}
        />
      </div>

      <section className="card">
        <h2>The difference, in code</h2>
        <div className="code-grid">
          <pre className="code bad">{NAIVE_CODE}</pre>
          <pre className="code good">{SAFE_CODE}</pre>
        </div>
      </section>

      <Explain title="What this proves">
        This is the problem the whole project exists to solve. Without locking, every request reads the balance
        before any other has finished spending, so all of them think there is enough money and the account goes
        negative. With <b>pessimistic locking</b> (<code>SELECT … FOR UPDATE</code>), the database makes the
        requests queue up on the account row, so each one sees the balance the previous one left. Accounts are
        always locked in sorted ID order, which also prevents two people paying each other from deadlocking.
        Even in the broken version the ledger itself stays balanced (debits still equal credits). What breaks is
        the rule "never spend money you don't have", and that is exactly what locking protects.
      </Explain>
    </div>
  );
}