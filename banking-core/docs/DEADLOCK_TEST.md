# Deadlock test: why two people paying each other can't freeze LedgerVault

Run it: `node scripts/deadlockTest.js`  (no server needed, only Postgres)

## 1. The problem in plain English

Alice sends money to Bob. At the same instant Bob sends money to Alice.
To move money safely, each transfer **locks both accounts** first
(`SELECT ... FOR UPDATE`), so nobody else can change them mid-transfer.

- Transfer 1 (Alice → Bob) locks **Alice**, then wants **Bob**.
- Transfer 2 (Bob → Alice) locks **Bob**, then wants **Alice**.

Transfer 1 holds Alice and waits for Bob. Transfer 2 holds Bob and waits for
Alice. Each is waiting for something the other will never release.
That is a **deadlock**. Postgres detects it after about a second and kills
one of the two (error code `40P01`, "deadlock detected"). The payment that was
killed **fails**, even though nothing was wrong with it.

## 2. The fix

Always lock accounts in the **same order**, whatever the direction of the
payment: lowest account id first. In `ledgerService.transfer()`:

```js
const [firstId, secondId] = [fromAccountId, toAccountId].sort();
// lock firstId, then lock secondId
```

Now both transfers lock the same account first. The second one simply waits
its turn at the first lock; it never holds one lock while wanting another
that is held by someone waiting on it. A circular wait becomes impossible.

## 3. What the test does

It runs the same kind of traffic twice, with two fresh pairs of accounts
(each with ₹1,00,000):

| Phase | Locking | Traffic | What we expect |
|---|---|---|---|
| 1. Naive | from-account first (the obvious way) | 50 transfers: 25 A→B and 25 B→A at the same instant | Deadlocks. Many payments fail. |
| 2. LedgerVault | lowest id first (the real code) | 200 transfers: 100 A→B (₹10) and 100 B→A (₹7) at the same instant | **0 deadlocks, 200 succeed** |

Phase 1 has a 5 ms pause between taking the first and second lock. That is
a stand-in for the real work (validation, checks) that happens between the two
locks in a real system, and it makes the bad timing likely instead of rare.
Phase 1 exists to **prove the problem is real**; a test that never fails the
bad version proves nothing.

Then it checks:
1. Zero deadlocks in phase 2.
2. All 200 transfers succeeded.
3. Account A and B each have **exactly** the expected balance
   (A: 1,00,000 − 100×10 + 100×7 = ₹99,700; B: ₹1,00,300).
4. A + B is unchanged: no money created or lost.
5. Even in phase 1, the transfers Postgres killed left no half-written
   money behind (the database transaction rolled them back completely).

## 4. Typical output

```
PHASE 1 - NAIVE locking: 50 transfers
  finished in 17.2s: 11 succeeded, 39 killed by Postgres as DEADLOCKS
PHASE 2 - LEDGERVAULT locking: 200 transfers
  finished in 1.2s: 200 succeeded, 0 deadlocks, 0 other errors
✅ DEADLOCK TEST PASSED
```

Notice the time too: the naive version is also **14× slower** for a quarter
of the traffic, because every deadlock stalls for about a second until
Postgres notices it.

Exact numbers in phase 1 vary run to run (timing is random). The pattern
does not: most naive transfers die, the LedgerVault ones never do.

## 5. What you can say about it (resume / interview)

Resume line (accurate to what is tested):
> Prevented A↔B deadlocks by locking accounts in sorted-ID order; verified
> with a test firing 200 simultaneous opposite-direction transfers (0
> deadlocks, balances exact) against a naive version in which roughly
> three quarters of the same kind of transfers failed with deadlocks.

Short interview answer:
> "If two transfers lock the same two accounts in opposite order they can
> deadlock. I always acquire row locks in ascending account-id order, so a
> circular wait can't form. I tested it by running the naive approach and
> mine under the same load: the naive one produced Postgres deadlock
> errors, mine produced none and the balances matched exactly."

Likely follow-ups:
- **Why does sorting work?** A deadlock needs a cycle of waiting. If everyone
  takes locks in one global order, any waiting chain goes "up" the order and
  can never loop back.
- **Why not just retry the failed one?** You can, as a safety net, but
  retries cost time and add complexity. Avoiding the deadlock is cheaper than
  recovering from it.
- **Does it still work for 3+ accounts?** Yes, the same rule (global order)
  works for any number of locks.
- **What does Postgres do on its own?** It detects the cycle (after
  `deadlock_timeout`, 1 s by default) and aborts one transaction. That is a
  rescue, not a design: the user still sees a failed payment.
- **Why a database transaction as well?** So the debit and the credit are
  written together or not at all. That is why the killed naive transfers lost
  no money.

## 6. Honest limits
- It demonstrates a single Postgres instance. Row locks do not coordinate
  across separate databases.
- The 5 ms pause in phase 1 makes deadlocks more likely than in a quiet
  system. In production they would be rarer but still real under load.
- The connection pool (Sequelize default: 5) limits true parallelism; the
  naive deadlocks still appear because only two connections are needed to
  deadlock.