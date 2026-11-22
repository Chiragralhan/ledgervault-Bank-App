const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { User } = require('../models');
const redis = require('../config/redis');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');

const SALT_ROUNDS = 10;

class InvalidCredentialsError extends Error {}
class TokenRevokedError extends Error {}

// Parses simple expiry strings like '15m', '7d', '1h' into seconds -
// used to set a matching TTL on the Redis key so it auto-expires at the
// same time the JWT itself would, even if nobody ever logs out.
function parseExpiryToSeconds(expiry) {
  const match = /^(\d+)([smhd])$/.exec(expiry);
  if (!match) return 7 * 24 * 60 * 60; // default 7 days
  const value = Number(match[1]);
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[match[2]];
}

const REFRESH_TTL_SECONDS = parseExpiryToSeconds(process.env.JWT_REFRESH_EXPIRY || '7d');

// Public registration ALWAYS creates a plain USER. The role is never read
// from the request - otherwise anyone could register themselves as ADMIN
// (and ADMIN bypasses the account-ownership check in ledgerService).
// Admins are promoted manually via scripts/makeAdmin.js.
async function register({ name, email, password }) {
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({ name, email, password_hash, role: 'USER' });
  return user;
}

/**
 * Issues a fresh access + refresh token pair for a user.
 *
 * The access token is a plain, stateless JWT - the server never stores it
 * anywhere, it's just verified by signature on each request. This is why
 * it's kept SHORT-LIVED (15 min default): a stateless token can't be
 * revoked early, so the only way to limit how long a stolen one stays
 * dangerous is to make it expire quickly.
 *
 * The refresh token is also a JWT, but it carries a unique `jti` (JWT ID)
 * that we ALSO store in Redis. Redis is the real source of truth here -
 * deleting the Redis key instantly revokes that refresh token (logout),
 * even though the JWT itself would still pass signature verification
 * until it naturally expires. This is what gives us "instant revocation"
 * without having to check a blocklist on every single access-token
 * request.
 */
async function issueTokens(user) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });

  const jti = crypto.randomUUID();
  const refreshToken = signRefreshToken({ sub: user.id, jti });

  await redis.set(`refresh:${user.id}:${jti}`, '1', 'EX', REFRESH_TTL_SECONDS);

  return { accessToken, refreshToken };
}

async function login({ email, password }) {
  const user = await User.findOne({ where: { email } });
  if (!user) throw new InvalidCredentialsError('Invalid email or password');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new InvalidCredentialsError('Invalid email or password');

  const tokens = await issueTokens(user);
  return { user, ...tokens };
}

/**
 * Exchanges a valid, non-revoked refresh token for a brand new
 * access+refresh pair. The old refresh token is deleted (rotation) -
 * each refresh token is meant to be used ONCE. This limits how long a
 * leaked refresh token stays useful.
 */
async function refresh(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new TokenRevokedError('Invalid or expired refresh token');
  }

  const redisKey = `refresh:${payload.sub}:${payload.jti}`;
  const exists = await redis.get(redisKey);
  if (!exists) {
    // Cryptographically valid, but not present in Redis - it's been
    // logged out or already used once (rotation). Treat as invalid.
    throw new TokenRevokedError('Refresh token has been revoked');
  }

  const user = await User.findByPk(payload.sub);
  if (!user) throw new TokenRevokedError('User no longer exists');

  await redis.del(redisKey);
  const tokens = await issueTokens(user);
  return { user, ...tokens };
}

/** Revokes a single refresh token (normal logout on one device). */
async function logout(userId, refreshToken) {
  try {
    const payload = verifyRefreshToken(refreshToken);
    await redis.del(`refresh:${userId}:${payload.jti}`);
  } catch (err) {
    // Already invalid/expired - logout's end state is achieved either way.
  }
}

/** Revokes every refresh token a user has ever issued ("log out everywhere"). */
async function logoutAll(userId) {
  const stream = redis.scanStream({ match: `refresh:${userId}:*` });
  const keysToDelete = [];
  for await (const keys of stream) {
    keysToDelete.push(...keys);
  }
  if (keysToDelete.length) {
    await redis.del(...keysToDelete);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  InvalidCredentialsError,
  TokenRevokedError,
};