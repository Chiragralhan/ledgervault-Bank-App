import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatRupees } from '../api';
import Explain from '../components/Explain';
import Legs from '../components/Legs';

const PAGE_SIZE = 10;

// A human-readable one-liner for a transaction, from the point of view of
// THIS account, worked out from the ledger legs.
function describe(item) {
  const others = item.legs.filter((l) => !l.isThisAccount);
  const mine = item.thisAccount.direction;
  if (mine === 'CREDIT') {
    const src = others.find((l) => l.direction === 'DEBIT');
    if (src && src.kind === 'RESERVE') return 'Cash deposit';
    return src ? `Received from ${src.label}` : 'Credit';
  }
  const dest = others.find((l) => l.direction === 'CREDIT' && l.kind !== 'FEES');
  return dest ? `Sent to ${dest.label}` : 'Debit';
}

function feeOf(item) {
  const fee = item.legs.find((l) => l.kind === 'FEES');
  return fee ? fee.amountPaise : 0;
}

export default function Statement() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(null);
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(null); // transactionId of the expanded row
  const [error, setError] = useState('');

  // Load my accounts; with no account in the URL, jump to the first one.
  useEffect(() => {
    api
      .get('/api/ledger/accounts')
      .then((list) => {
        setAccounts(list);
        if (!accountId && list.length > 0) navigate(`/statement/${list[0].id}`, { replace: true });
      })
      .catch((err) => setError(err.message));
  }, [accountId, navigate]);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setData(await api.get(`/api/ledger/accounts/${accountId}/transactions?limit=${PAGE_SIZE}&offset=${offset}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [accountId, offset]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => {
    setOffset(0);
    setOpen(null);
  }, [accountId]);

  if (accounts && accounts.length === 0) {
    return (
      <div className="page">
        <h1>Statement</h1>
        <div className="card empty">Open an account on the Dashboard first.</div>
      </div>
    );
  }

  const lastPage = data ? offset + PAGE_SIZE >= data.total : true;

  return (
    <div className="page">
      <h1>Statement</h1>

      {accounts && (
        <div className="row">
          <select className="picker" value={accountId || ''} onChange={(e) => navigate(`/statement/${e.target.value}`)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountType} · …{a.id.slice(-4)}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {data && (
        <section className="card total">
          <div className="muted small">Current balance (sum of all ledger rows below)</div>
          <div className="big">{formatRupees(data.account.balancePaise)}</div>
        </section>
      )}

      {data && data.items.length === 0 && <div className="card empty">No transactions yet. Add money from the Dashboard.</div>}

      {data && data.items.length > 0 && (
        <section className="card">
          <table className="stmt">
            <thead>
              <tr>
                <th>Date</th>
                <th>Details</th>
                <th className="num">Money in / out</th>
                <th className="num">Balance after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => {
                const isOpen = open === item.transactionId;
                const credit = item.thisAccount.direction === 'CREDIT';
                const fee = feeOf(item);
                return (
                  <Fragment key={item.transactionId}>
                    <tr className="clickable" onClick={() => setOpen(isOpen ? null : item.transactionId)}>
                      <td className="small">{new Date(item.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td>
                        {describe(item)}
                        {!credit && fee > 0 && <div className="muted small">includes fee {formatRupees(fee)}</div>}
                      </td>
                      <td className={`num ${credit ? 'in' : 'out'}`}>
                        {credit ? '+' : '−'}
                        {formatRupees(item.thisAccount.amountPaise)}
                      </td>
                      <td className="num">{formatRupees(item.thisAccount.runningBalancePaise)}</td>
                      <td className="chev">{isOpen ? '▾' : '▸'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="detail">
                        <td colSpan={5}>
                          <div className="muted small" style={{ marginBottom: 8 }}>
                            The full ledger entry. Your account is in bold. Transaction <span className="mono">{item.transactionId.slice(0, 8)}…</span>
                          </div>
                          <Legs legs={item.legs} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <div className="pager">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              ← Newer
            </button>
            <span className="muted small">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
            </span>
            <button className="btn" disabled={lastPage} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Older →
            </button>
          </div>
        </section>
      )}

      <Explain title="Reading a statement like an accountant">
        Every row is one ledger entry on your account. <b>Balance after</b> is a running total: all your earlier
        credits minus debits, up to and including that row. The newest row's balance equals your current
        balance, because the balance <i>is</i> that sum. Click any row to open the full transaction: you will
        see the other side of the money, and that debits equal credits. Nothing here is ever edited or deleted.
        If something was wrong, a new reversing entry would be added, which is how real banks keep an audit
        trail.
      </Explain>
    </div>
  );
}