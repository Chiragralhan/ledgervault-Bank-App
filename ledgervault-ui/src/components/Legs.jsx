import { formatRupees } from '../api';

// Shows a transaction the way an accountant sees it: a list of ledger rows
// ("legs"), each a DEBIT (money leaves) or a CREDIT (money arrives).
// The rule of double entry: total debits always equal total credits.
// Used on the Send page (a preview) and on the Statement page (real data).
export default function Legs({ legs }) {
  const debit = legs.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountPaise, 0);
  const credit = legs.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountPaise, 0);

  return (
    <table className="legs">
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Debit (out)</th>
          <th className="num">Credit (in)</th>
        </tr>
      </thead>
      <tbody>
        {legs.map((l, i) => (
          <tr key={i} className={l.isThisAccount ? 'mine' : ''}>
            <td>{l.label}</td>
            <td className="num out">{l.direction === 'DEBIT' ? formatRupees(l.amountPaise) : ''}</td>
            <td className="num in">{l.direction === 'CREDIT' ? formatRupees(l.amountPaise) : ''}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="num">{formatRupees(debit)}</td>
          <td className="num">{formatRupees(credit)}</td>
        </tr>
        <tr>
          <td colSpan={3} className={debit === credit ? 'balanced' : 'unbalanced'}>
            {debit === credit ? '✓ Debits equal credits: the entry is balanced' : '✗ NOT balanced'}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}