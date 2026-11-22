import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, formatRupees } from '../api';
import Explain from '../components/Explain';
import Legs from '../components/Legs';

const PAGE_SIZE = 10;

const TYPE_NOTE = {
  SAVINGS: 'Customer savings accounts',
  CURRENT: 'Customer current accounts',
  FEES: 'Fees the bank has earned',
  SYSTEM: 'Bank reserve (cash in) and demo sandbox accounts',
};

function IntegrityCard({ report, onRecheck, checking }) {
  if (!report) return <section className="card muted">Checking the books…</section>;
  const ok = report.balanced;
  return (
    <section className={`card integrity ${ok ? 'ok' : 'bad'}`}>
      <div className="integrity-head">
        <div>
          <div className="integrity-title">{ok ? '✓ The books are balanced' : '✗ THE BOOKS DO NOT BALANCE'}</div>
          <div className="small">
            Checked just now across {report.transactionCount.toLocaleString('en-IN')} transactions and{' '}
            {report.ledgerEntryCount.toLocaleString('en-IN')} ledger entries.
          </div>
        </div>
        <button className="btn" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check now'}
        </button>
      </div>
      <div className="proofs">
        <div className="proof">
          <div className="muted small">Total debits (money out)</div>
          <b>{formatRupees(report.totalDebitsPaise)}</b>
        </div>
        <div className="proof-eq">{report.totalDebitsPaise === report.totalCreditsPaise ? '=' : '≠'}</div>
        <div className="proof">
          <div className="muted small">Total credits (money in)</div>
          <b>{formatRupees(report.totalCreditsPaise)}</b>
        </div>
        <div className="proof">
          <div className="muted small">All balances added together</div>
          <b>{formatRupees(report.sumOfAllBalancesPaise)}</b>
        </div>
        <div className="proof">
          <div className="muted small">Unbalanced transactions</div>
          <b>{report.unbalancedTransactions.length}</b>
        </div>
      </div>
    </section>
  );
}

export default function Admin() {
  const [report, setReport] = useState(null);
  const [checking, setChecking] = useState(false);
  const [fees, setFees] = useState(null);
  const [txns, setTxns] = useState(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');

  const loadReport = useCallback(async () => {
    setChecking(true);
    try {
      const [r, f] = await Promise.all([api.get('/api/ledger/admin/integrity'), api.get('/api/ledger/admin/fees-balance')]);
      setReport(r);
      setFees(f);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, []);

  const loadTxns = useCallback(async () => {
    try {
      setTxns(await api.get(`/api/ledger/admin/transactions?limit=${PAGE_SIZE}&offset=${offset}`));
    } catch (err) {
      setError(err.message);
    }
  }, [offset]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);
  useEffect(() => {
    loadTxns();
  }, [loadTxns]);

  const lastPage = txns ? offset + PAGE_SIZE >= txns.total : true;

  return (
    <div className="page">
      <div>
        <h1>Bank admin</h1>
        <p className="muted">The view only a bank employee gets: everything, and proof that it all adds up.</p>
      </div>

      {error && <div className="error">{error}</div>}

      <IntegrityCard report={report} onRecheck={loadReport} checking={checking} />

      <div className="grid">
        {fees && (
          <section className="card">
            <div className="muted small">Fees collected so far</div>
            <div className="big">{formatRupees(fees.balancePaise)}</div>
            <div className="muted small">The bank's earnings from transfer fees</div>
          </section>
        )}
        {report && (
          <section className="card">
            <h2>Money by account type</h2>
            <table className="stmt">
              <tbody>
                {report.balancesByType.map((r) => (
                  <tr key={r.accountType}>
                    <td>
                      <b>{r.accountType}</b> <span className="muted small">({r.accounts})</span>
                      <div className="muted small">{TYPE_NOTE[r.accountType]}</div>
                    </td>
                    <td className={`num ${r.balancePaise < 0 ? 'out' : ''}`}>{formatRupees(r.balancePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      <section className="card">
        <h2>All bank transactions</h2>
        {!txns && <div className="muted">Loading…</div>}
        {txns && txns.items.length === 0 && <div className="muted">No transactions yet.</div>}
        {txns && txns.items.length > 0 && (
          <>
            <table className="stmt">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th className="num">Amount moved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {txns.items.map((t) => {
                  const isOpen = open === t.transactionId;
                  const from = t.legs.find((l) => l.direction === 'DEBIT');
                  const to = t.legs.find((l) => l.direction === 'CREDIT' && l.kind !== 'FEES');
                  return (
                    <Fragment key={t.transactionId}>
                      <tr className="clickable" onClick={() => setOpen(isOpen ? null : t.transactionId)}>
                        <td className="small">{new Date(t.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td>
                          {from ? from.label : '?'} → {to ? to.label : '?'}
                          <div className="muted small">{t.description || t.type}</div>
                        </td>
                        <td className="num">{formatRupees(t.debitTotalPaise)}</td>
                        <td className="chev">{isOpen ? '▾' : '▸'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="detail">
                          <td colSpan={4}>
                            <Legs legs={t.legs} />
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
                {offset + 1}–{Math.min(offset + PAGE_SIZE, txns.total)} of {txns.total}
              </span>
              <button className="btn" disabled={lastPage} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Older →
              </button>
            </div>
          </>
        )}
      </section>

      <Explain title="Why the books always balance, and who may see this page">
        Every transaction is written as matching debit and credit rows, so across the whole bank total debits must
        equal total credits. The second check adds up <i>every</i> account's balance (customers, the fee account and
        the bank reserve) and expects exactly zero: deposits make the bank reserve go negative by the same amount
        that customers go positive, so nothing is created or lost. If this page ever showed a red banner, it would
        mean a bug or tampering. <b>Access control:</b> this page and its API calls require the ADMIN role. The menu
        link is hidden for normal users, but that is only cosmetic. The real protection is on the server, which
        rejects every admin request from a non-admin token with 403 (route-level role check). Admins are created
        only by a script, never through public registration.
      </Explain>
    </div>
  );
}