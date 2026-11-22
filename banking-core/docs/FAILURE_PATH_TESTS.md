# Failure-path tests: proving LedgerVault stays safe when people misbehave

Run it: start the server (`npm run dev`), then in another terminal
`node scripts/failurePathTests.js`

## 1. Why these tests exist

The earlier tests (smoke test, stress test) prove the app works when people
behave. A banking app is judged on the opposite: what happens with a wrong
password, a stolen token, a normal user poking at admin pages, a tampered
amount, a double-click, an empty account?

For each attack the test checks **two things**:
1. The right error comes back (401, 403, 400, 404, 409).
2. **No money moved.** (Balances are re-checked after each group of attacks.)

At the end, the integrity report must still say the books are balanced.

## 2. What is tested (48 checks)

### Login and registration (5)
| Attack | Expected | Why it matters |
|---|---|---|
| Wrong password | 401 | Basic protection |
| Unknown email | 401, **same message** as wrong password | Attackers can't discover which emails have accounts |
| Register an existing email | 409 | No duplicate accounts |
| Register with missing fields | 400 | Clean validation errors |
| Register with `role: "ADMIN"` in the body | Created as USER | Nobody can make themselves admin |

### Tokens (8)
| Attack | Expected |
|---|---|
| No token / garbage token | 401 |
| **Expired** access token | 401 |
| Forged ADMIN token signed with the wrong secret | 401 |
| Unsigned token (`alg: none` trick) | 401 |
| Refresh token used as an access token | 401 |
| Access token used to refresh | 401 |
| Garbage refresh token | 401 |

The point: the server only trusts tokens it signed itself, and only the
right *kind* of token for the right job (two different secrets).

### Refresh-token rotation and revocation (3)
- Refreshing gives a **new** pair of tokens.
- The **old** refresh token is dead immediately (stolen-token replay blocked).
- After **logout**, the refresh token stops working at once (it was deleted
  from Redis; this is the "revocable" part of the resume line).

### Role-based access (4)
A normal user calling each admin route (integrity, fees balance, all
transactions, run-due-payments) gets **403**. The menu being hidden in the
UI is cosmetic; this is the real lock.

### Other people's money (7)
A second user ("Mallory") tries to: read Alice's balance, read her statement,
transfer **out of** her account, deposit into it, cancel her recurring
payment, schedule payments out of her account. All get **403**. Afterwards
Alice still has exactly her original balance.

### Bad input to the transfer endpoint (10)
Negative, zero, decimal (10.5 paise), string (`"500"`), missing amount,
same account, malformed account id: all **400**. Non-existent destination:
**404**. Missing `Idempotency-Key` header: **400**. Afterwards, no balances
changed. Money is whole integer paise, so floats and strings can never reach
the ledger.

### Not enough money (3)
- More than the balance → 400.
- A balance that covers the amount but **not the fee** → 400 (the fee is
  counted before approving).
- Balances unchanged afterwards.

### Retries and double-clicks (7)
| Scenario | Expected |
|---|---|
| Same key sent twice | Same transaction returned, charged **once** |
| 5 identical requests at the same instant | **One** transfer created; the others get 409 "in progress" |
| Two users using the same key string | They never see each other's result (keys are per user) |
| A *rejected* request replayed with the same key | Gets the same answer (by design: the key identifies one attempt) |
| A **new** key after fixing the problem (adding money) | Succeeds |

### Final check (1)
The admin integrity report: total debits = total credits, and all account
balances sum to zero, after every attack above.

## 3. Typical output

```
--- 8. Retries and double-clicks (idempotency) ---
✅ PASS - same Idempotency-Key twice returns the SAME transaction
✅ PASS - ...and Alice was charged only ONCE (₹100 + fee = 10100 paise)
✅ PASS - 5 identical requests at the SAME instant -> only one transfer is created (statuses: 201,409,409,409,409)
...
✅ ALL 48 FAILURE-PATH CHECKS PASSED
```

## 4. Things worth understanding

- **401 vs 403.** 401 = "I don't know who you are" (no/bad/expired token).
  403 = "I know who you are, and you're not allowed."
- **Why does a failed transfer leave no trace?** It happens inside a database
  transaction. If any step throws, everything is rolled back.
- **Why is a replayed *rejected* request answered the same way?** The
  Idempotency-Key means "this one attempt". Replaying the key returns that
  attempt's recorded result. To try again after fixing the cause, the client
  makes a new key. (The UI does exactly this.)
- **Why 409 for the simultaneous burst?** While the first request is in
  flight, the key is marked "processing" in Redis (atomic `SET NX`). Duplicates
  arriving during that window are refused with 409; ones arriving after it
  finishes get the saved result.

## 5. Interview answers

> "Besides the happy path, I wrote a failure-path suite: 48 checks for
> expired and forged tokens, role escalation, accessing other users'
> accounts, malformed amounts, insufficient funds including fees, and
> duplicate/concurrent requests. Every check asserts the status code *and*
> that no balance changed, and the suite ends by verifying that total debits
> equal total credits."

Likely follow-ups:
- **How do you stop a user making themselves admin?** Registration ignores
  any role in the request; admins are created only by a server-side script.
  Even a forged token fails because it isn't signed with the server's secret.
- **What if an access token is stolen?** It dies in 15 minutes; the refresh
  token is stored server-side in Redis and rotates on every use, so a
  replayed old one is rejected, and logout revokes it immediately.
- **Why prefix idempotency keys with the user id?** So one user can't
  collide with, or read the cached response of, another user's request.

## 6. Honest limits
- Tokens are checked against the server's secrets, but there is no rate
  limiting or account lockout yet (brute-force protection would be next).
- The test uses direct database access only to promote one test user to admin
  for the final integrity check.
- These are black-box HTTP tests against a running server on a development
  database, not unit tests of individual functions.