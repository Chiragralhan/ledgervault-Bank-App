// Postgres rejects a malformed UUID with a database error, which would
// surface to the client as a confusing 500. Checking the format up front
// lets us return a clean 400 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { isUuid };