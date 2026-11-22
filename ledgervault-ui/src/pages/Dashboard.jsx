import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { api, formatRupees, newIdempotencyKey } from '../api';
import AccountCard from '../components/AccountCard';
import SessionPanel from '../components/SessionPanel';
import Explain from '../components/Explain';

export default function Dashboard() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState(null); // null = still loading
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const openKey = useRef(newIdempotencyKey());

  const load = useCallback(async () => {
    try {
      setAccounts(await api.get('/api/ledger/accounts'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openAccount(accountType) {
    setOpening(true);
    setError('');
    try {
      await api.post('/api/ledger/accounts', { accountType }, openKey.current);
      openKey.current = newIdempotencyKey(); // next click = a new, separate action
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setOpening(false);
    }
  }

  const total = accounts ? accounts.reduce((sum, a) => sum + a.balancePaise, 0) : 0;

  return (
    <div className="page">
      <div>
        <h1>Hello, {user.name}</h1>
        <p className="muted">Your accounts and balances.</p>
      </div>

      <section className="card total">
        <div className="muted small">Total across all accounts</div>
        <div className="big">{accounts ? formatRupees(total) : '…'}</div>
      </section>

      {error && <div className="error">{error}</div>}

      {accounts && accounts.length === 0 && (
        <div className="card empty">
          You have no accounts yet. Open one below, then use <b>Add money</b> to put some funds in it.
        </div>
      )}

      <div className="grid">
        {accounts && accounts.map((a) => <AccountCard key={a.id} account={a} onChanged={load} />)}
      </div>

      <div className="row">
        <button className="btn primary" disabled={opening} onClick={() => openAccount('SAVINGS')}>
          + Open savings account
        </button>
        <button className="btn" disabled={opening} onClick={() => openAccount('CURRENT')}>
          + Open current account
        </button>
      </div>

      <Explain title="Where does the balance come from?">
        There is <b>no balance column</b> in the database. Every balance you see is calculated live by adding up
        the account's ledger entries (credits minus debits). When you <b>Add money</b>, the bank's internal
        reserve account is debited and your account is credited by the same amount, so every deposit is a
        matching pair of entries. Amounts are stored as whole <b>paise</b>, never decimals, so rounding errors
        are impossible. Try double-clicking "Add": thanks to the Idempotency-Key sent with the request, the
        money is added only once.
      </Explain>

      <SessionPanel />
    </div>
  );
}