// const redis = require('../config/redis');

// const PROCESSING_TTL_SECONDS = 30; // how long a "processing" claim holds before considered stale
// const RESULT_TTL_SECONDS = 24 * 60 * 60; // how long we remember a completed response (24h)

// /**
//  * Idempotency guard for money-moving endpoints.
//  *
//  * PROBLEM THIS SOLVES: a user double-clicks "Transfer", or their phone's
//  * network flakes and the client auto-retries a request that actually DID
//  * reach the server and succeed. Without this, that's two separate
//  * transfer() calls - two debits, two credits, real duplicated money
//  * movement. Step 3's locking does NOT stop this - locking only makes
//  * concurrent access to one account SAFE, it doesn't know or care that two
//  * requests are actually "the same" logical request. This is a different
//  * problem: not "is this operation safe under concurrency" but "have I
//  * already handled this exact request before".
//  *
//  * HOW IT WORKS: the client sends a unique `Idempotency-Key` header per
//  * logical request (usually a UUID generated once on the client, reused
//  * automatically on retries by the client). We use Redis SET with NX
//  * (set-if-not-exists) as an ATOMIC claim on that key - this atomicity is
//  * the whole point, it's what makes this safe even if two duplicate
//  * requests arrive at literally the same millisecond:
//  *
//  *   - Key doesn't exist yet -> we are the first to see this request.
//  *     Claim it (mark "processing"), let the request through to the
//  *     actual handler, then overwrite the key with the real response so
//  *     future retries get the SAME result instead of running again.
//  *   - Key exists and holds a COMPLETED response -> this is a retry of a
//  *     request we already finished. Return the cached response
//  *     immediately without touching the ledger again.
//  *   - Key exists but is still "processing" -> the original request is
//  *     still in flight (e.g. a fast double-click within milliseconds).
//  *     Reject this one with 409 so we never run the same transfer twice.
//  */
// function requireIdempotencyKey(req, res, next) {
//   const key = req.header('Idempotency-Key');
//   if (!key) {
//     return res.status(400).json({ error: 'Idempotency-Key header is required' });
//   }
//   req.idempotencyKey = `idempotency:${key}`;
//   next();
// }

// async function idempotencyGuard(req, res, next) {
//   const redisKey = req.idempotencyKey;

//   // Atomic claim: this SET only succeeds ('OK') if nobody has claimed
//   // this key yet. If someone else claimed it a millisecond ago, this
//   // returns null instead - Redis guarantees only ONE caller ever wins
//   // this race, no matter how many hit it at the same instant.
//   const claimed = await redis.set(
//     redisKey,
//     JSON.stringify({ status: 'processing' }),
//     'EX',
//     PROCESSING_TTL_SECONDS,
//     'NX'
//   );

//   if (claimed === 'OK') {
//     // We won the claim - proceed to the actual transfer handler.
//     return next();
//   }

//   // Key already exists - find out what state it's in.
//   const existingRaw = await redis.get(redisKey);
//   const existing = existingRaw ? JSON.parse(existingRaw) : null;

//   if (existing && existing.status === 'completed') {
//     // A retry of a request we already finished - return the exact same
//     // result, don't touch the ledger again.
//     return res.status(existing.httpStatus).json(existing.body);
//   }

//   // Still processing (the original request hasn't finished yet) - reject
//   // this duplicate outright rather than letting it wait and possibly
//   // double-run once the first one completes.
//   return res.status(409).json({ error: 'Duplicate request already in progress' });
// }

// /**
//  * Call this AFTER a transfer attempt (success OR an expected failure like
//  * insufficient balance) to store the result, so retries of the same
//  * Idempotency-Key get this exact response instead of re-running the
//  * transfer against the ledger again.
//  */
// async function storeIdempotentResult(idempotencyKey, httpStatus, body) {
//   await redis.set(
//     idempotencyKey,
//     JSON.stringify({ status: 'completed', httpStatus, body }),
//     'EX',
//     RESULT_TTL_SECONDS
//   );
// }

// module.exports = { requireIdempotencyKey, idempotencyGuard, storeIdempotentResult };






const redis = require('../config/redis');

const PROCESSING_TTL_SECONDS = 30; // how long a "processing" claim holds before considered stale
const RESULT_TTL_SECONDS = 24 * 60 * 60; // how long we remember a completed response (24h)

/**
 * Idempotency guard for money-moving endpoints.
 *
 * PROBLEM THIS SOLVES: a user double-clicks "Transfer", or their phone's
 * network flakes and the client auto-retries a request that actually DID
 * reach the server and succeed. Without this, that's two separate
 * transfer() calls - two debits, two credits, real duplicated money
 * movement. Step 3's locking does NOT stop this - locking only makes
 * concurrent access to one account SAFE, it doesn't know or care that two
 * requests are actually "the same" logical request. This is a different
 * problem: not "is this operation safe under concurrency" but "have I
 * already handled this exact request before".
 *
 * HOW IT WORKS: the client sends a unique `Idempotency-Key` header per
 * logical request (usually a UUID generated once on the client, reused
 * automatically on retries by the client). We use Redis SET with NX
 * (set-if-not-exists) as an ATOMIC claim on that key - this atomicity is
 * the whole point, it's what makes this safe even if two duplicate
 * requests arrive at literally the same millisecond:
 *
 *   - Key doesn't exist yet -> we are the first to see this request.
 *     Claim it (mark "processing"), let the request through to the
 *     actual handler, then overwrite the key with the real response so
 *     future retries get the SAME result instead of running again.
 *   - Key exists and holds a COMPLETED response -> this is a retry of a
 *     request we already finished. Return the cached response
 *     immediately without touching the ledger again.
 *   - Key exists but is still "processing" -> the original request is
 *     still in flight (e.g. a fast double-click within milliseconds).
 *     Reject this one with 409 so we never run the same transfer twice.
 */
function requireIdempotencyKey(req, res, next) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }
  // Scoped per user: two different users who happen to send the same
  // Idempotency-Key must NOT collide or see each other's cached response.
  // (authenticate runs before this middleware, so req.user is set.)
  req.idempotencyKey = `idempotency:${req.user.id}:${key}`;
  next();
}

async function idempotencyGuard(req, res, next) {
  const redisKey = req.idempotencyKey;

  // Atomic claim: this SET only succeeds ('OK') if nobody has claimed
  // this key yet. If someone else claimed it a millisecond ago, this
  // returns null instead - Redis guarantees only ONE caller ever wins
  // this race, no matter how many hit it at the same instant.
  const claimed = await redis.set(
    redisKey,
    JSON.stringify({ status: 'processing' }),
    'EX',
    PROCESSING_TTL_SECONDS,
    'NX'
  );

  if (claimed === 'OK') {
    // We won the claim - proceed to the actual transfer handler.
    return next();
  }

  // Key already exists - find out what state it's in.
  const existingRaw = await redis.get(redisKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;

  if (existing && existing.status === 'completed') {
    // A retry of a request we already finished - return the exact same
    // result, don't touch the ledger again.
    return res.status(existing.httpStatus).json(existing.body);
  }

  // Still processing (the original request hasn't finished yet) - reject
  // this duplicate outright rather than letting it wait and possibly
  // double-run once the first one completes.
  return res.status(409).json({ error: 'Duplicate request already in progress' });
}

/**
 * Call this AFTER a transfer attempt (success OR an expected failure like
 * insufficient balance) to store the result, so retries of the same
 * Idempotency-Key get this exact response instead of re-running the
 * transfer against the ledger again.
 */
async function storeIdempotentResult(idempotencyKey, httpStatus, body) {
  await redis.set(
    idempotencyKey,
    JSON.stringify({ status: 'completed', httpStatus, body }),
    'EX',
    RESULT_TTL_SECONDS
  );
}

module.exports = { requireIdempotencyKey, idempotencyGuard, storeIdempotentResult };