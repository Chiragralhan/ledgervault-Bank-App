import { useEffect, useRef, useState } from 'react';
import { api, formatRupees, newIdempotencyKey } from '../api';
import { rupeesToPaise } from '../money';
import Explain from '../components/Explain';
import Legs from '../components/Legs';

export default function Send() {
  const [accounts, setAccounts] = useState(null);
  const [fromId, setFromId] = useState('');
  const [email, setEmail] = useState('');
  const [recipient, setRecipient] = useState(null); // { name, accounts: [{id, accountType}] }
  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [quote, setQuote] = useState(null);
  const [step, setStep] = useState('form'); // 'form' | 'review' | 'done'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [result, setResult] = useState(null);
  const sendKey = useRef(newIdempotencyKey());

  // Load my accounts
  useEffect(() => {
    api
      .get('/api/ledger/accounts')
      .then((list) => {
        setAccounts(list);
        if (list.length > 0) setFromId(list[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  const amountPaise = rupeesToPaise(amountText);
  const from = accounts && accounts.find((a) => a.id === fromId);
  const to = recipient && recipient.accounts.find((a) => a.id === toId);

  // Live fee preview: ask the server what the fee would be as the user types.
  useEffect(() => {
    if (!amountPaise || amountPaise <= 0) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .get(`/api/ledger/fee-quote?amountPaise=${amountPaise}`)
        .then((q) => !cancelled && setQuote(q))
        .catch(() => !cancelled && setQuote(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [amountPaise]);

  async function findRecipient(e) {
    e.preventDefault();
    setLookupError('');
    setRecipient(null);
    setToId('');
    try {
      const r = await api.get(`/api/ledger/directory?email=${encodeURIComponent(email.trim())}`);
      setRecipient(r);
      setToId(r.accounts[0].id);
    } catch (err) {
      setLookupError(err.message);
    }
  }

  const enough = from && quote ? from.balancePaise >= quote.totalDebitPaise : false;
  const sameAccount = fromId && toId && fromId === toId;
  const canReview = from && to && quote && amountPaise > 0 && enough && !sameAccount;

  let formHint = '';
  if (quote && from && !enough) formHint = `Not enough balance. You need ${formatRupees(quote.totalDebitPaise)} (amount + fee).`;
  else if (sameAccount) formHint = 'Pick a different destination account.';

  async function confirmSend() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(
        '/api/ledger/transfer',
        { fromAccountId: fromId, toAccountId: toId, amountPaise },
        sendKey.current
      );
      setResult(res);
      setStep('done');
    } catch (err) {
      setError(err.message);
      // A definite answer from the server (400/403/404) means this attempt is
      // finished, so the next try needs a new key. Network errors / 500s keep
      // the SAME key, so retrying can never send the money twice.
      if (err.status && err.status < 500) sendKey.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    sendKey.current = newIdempotencyKey();
    setAmountText('');
    setQuote(null);
    setResult(null);
    setError('');
    setStep('form');
    api.get('/api/ledger/accounts').then(setAccounts).catch(() => {});
  }

  if (accounts && accounts.length === 0) {
    return (
      <div className="page">
        <h1>Send money</h1>
        <div className="card empty">Open an account on the Dashboard first.</div>
      </div>
    );
  }

  const previewLegs =
    quote && from && to
      ? [
          { label: `You (${from.accountType.toLowerCase()})`, direction: 'DEBIT', amountPaise: quote.totalDebitPaise },
          { label: `${recipient.name} (${to.accountType.toLowerCase()})`, direction: 'CREDIT', amountPaise: quote.amountPaise },
          { label: 'Bank fee account', direction: 'CREDIT', amountPaise: quote.feePaise },
        ]
      : [];

  return (
    <div className="page">
      <h1>Send money</h1>

      {step === 'form' && (
        <>
          <section className="card form">
            <label>
              From
              <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {accounts &&
                  accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountType} · {formatRupees(a.balancePaise)} · …{a.id.slice(-4)}
                    </option>
                  ))}
              </select>
            </label>

            <form onSubmit={findRecipient} className="lookup">
              <label>
                Recipient's email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@example.com" required />
              </label>
              <button className="btn">Find</button>
            </form>
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
              Amount (₹)
              <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="500" />
            </label>

            {quote && (
              <div className="breakdown">
                <div><span>Amount sent</span><b>{formatRupees(quote.amountPaise)}</b></div>
                <div>
                  <span>
                    Fee ({quote.feeBasisPoints / 100}%{quote.minimumFeeApplied ? ', minimum fee applied' : ''})
                  </span>
                  <b>{formatRupees(quote.feePaise)}</b>
                </div>
                <div className="total-line"><span>Total taken from you</span><b>{formatRupees(quote.totalDebitPaise)}</b></div>
                {from && <div className="muted"><span>Balance after</span><b>{formatRupees(from.balancePaise - quote.totalDebitPaise)}</b></div>}
              </div>
            )}
            {formHint && <div className="error">{formHint}</div>}
            {error && <div className="error">{error}</div>}

            <button className="btn primary" disabled={!canReview} onClick={() => setStep('review')}>
              Review transfer
            </button>
          </section>

          <Explain title="Why the fee preview is asked from the server">
            The fee rules live in <b>one place only</b>: the server. The page asks the server "what would the fee
            be?" so what you see is exactly what will be charged. Fees are tiered (cheaper percentage for bigger
            amounts, with a ₹1 minimum), calculated in whole paise using basis points, so no decimals are ever
            involved.
          </Explain>
        </>
      )}

      {step === 'review' && (
        <>
          <section className="card">
            <h2>
              Send {formatRupees(amountPaise)} to {recipient.name}
            </h2>
            <p className="muted">This is exactly what will be written to the ledger:</p>
            <Legs legs={previewLegs} />
            {error && <div className="error">{error}</div>}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary" disabled={busy} onClick={confirmSend}>
                {busy ? 'Sending…' : 'Confirm & send'}
              </button>
              <button className="btn" disabled={busy} onClick={() => { setError(''); setStep('form'); }}>
                Back
              </button>
            </div>
          </section>
          <Explain title="Your money in three rows">
            A transfer is not "subtract here, add there". It is three rows added to an append-only ledger: one
            DEBIT from you for the amount plus fee, one CREDIT to the recipient, and one CREDIT to the bank's fee
            account. Debits always equal credits. When you press Confirm, the server locks both accounts, checks
            the balance, and writes all three rows in a single database transaction, so either everything
            happens or nothing does. The Confirm button carries an Idempotency-Key, so even if the network
            drops and the page retries, you are charged once.
          </Explain>
        </>
      )}

      {step === 'done' && result && (
        <>
          <section className="card success-card">
            <h2>✓ Sent {formatRupees(result.amountPaise)} to {recipient.name}</h2>
            <p className="muted">Fee {formatRupees(result.feePaise)} · total taken {formatRupees(result.totalDebitPaise)}</p>
            <div className="muted small mono">Transaction {result.transactionId}</div>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary" onClick={reset}>Send another</button>
            </div>
          </section>
          <Explain title="What just happened">
            The server locked both accounts in a fixed order (so two people paying each other at the same instant
            can never deadlock), checked your balance while holding the lock, wrote the three ledger rows and
            released the locks, all in one atomic transaction. Your new balance is simply the sum of your ledger
            rows.
          </Explain>
        </>
      )}
    </div>
  );
}