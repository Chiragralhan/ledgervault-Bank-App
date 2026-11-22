import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatRupees, newIdempotencyKey } from '../api';
import { rupeesToPaise } from '../money';

const MAX_DEPOSIT_PAISE = 10000000; // ₹1,00,000 (same cap as the server)

// One account: its balance, an "Add money" form and a link to its statement.
export default function AccountCard({ account, onChanged }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  // One Idempotency-Key per deposit ATTEMPT. If the request fails or is
  // retried we send the same key again, so the server can never deposit twice.
  // After a success we make a fresh key for the next, separate deposit.
  const keyRef = useRef(newIdempotencyKey());

  async function handleDeposit(e) {
    e.preventDefault();
    setError('');
    setDone('');
    const paise = rupeesToPaise(amount);
    if (paise === null || paise <= 0) return setError('Enter a valid amount, e.g. 500 or 250.50');
    if (paise > MAX_DEPOSIT_PAISE) return setError('Maximum per deposit is ₹1,00,000');

    setBusy(true);
    try {
      const result = await api.post(
        `/api/ledger/accounts/${account.id}/deposit`,
        { amountPaise: paise },
        keyRef.current
      );
      keyRef.current = newIdempotencyKey();
      setAmount('');
      setDone(`Added ${formatRupees(result.amountPaise)}. New balance ${formatRupees(result.balancePaise)}.`);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card account">
      <div className="account-head">
        <div>
          <span className="tag">{account.accountType}</span>
          <div className="muted small mono" title={account.id}>
            {account.id.slice(0, 8)}…{account.id.slice(-4)}
          </div>
        </div>
        <div className="big">{formatRupees(account.balancePaise)}</div>
      </div>

      {!open ? (
        <div className="row">
          <button className="btn" onClick={() => setOpen(true)}>
            + Add money
          </button>
          <Link className="btn" to={`/statement/${account.id}`}>
            Statement
          </Link>
        </div>
      ) : (
        <form className="inline-form" onSubmit={handleDeposit}>
          <span className="rupee">₹</span>
          <input
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
          <button className="btn primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </form>
      )}
      <div className="presets">
        {open &&
          [500, 1000, 5000].map((v) => (
            <button key={v} type="button" className="chip" onClick={() => setAmount(String(v))}>
              ₹{v.toLocaleString('en-IN')}
            </button>
          ))}
      </div>
      {error && <div className="error">{error}</div>}
      {done && <div className="success">{done}</div>}
    </div>
  );
}