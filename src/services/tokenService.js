const crypto = require('crypto');
const { query } = require('../config/database');

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSecureToken(ticketId, tokenType, expiryHours = 168) {
  const plain = generateSecureToken();
  const hashed = hashToken(plain);
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  await query(
    `INSERT INTO secure_tokens (ticket_id, token_type, token_hash, token_plain, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticketId, tokenType, hashed, plain, expiresAt]
  );

  return { token: plain, expiresAt };
}

async function validateSecureToken(ticketId, token, tokenType) {
  const hashed = hashToken(token);
  const result = await query(
    `SELECT * FROM secure_tokens
     WHERE ticket_id = $1 AND token_hash = $2 AND token_type = $3 AND is_used = FALSE
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [ticketId, hashed, tokenType]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

async function markTokenUsed(tokenId, ipAddress = null) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await query(
    'UPDATE secure_tokens SET is_used = TRUE, used_at = $1, ip_address = $2 WHERE id = $3',
    [now, ipAddress, tokenId]
  );
}

async function getOrCreateToken(ticketId, tokenType, expiryHours = 168) {
  // Check for existing valid token
  const existing = await query(
    `SELECT * FROM secure_tokens
     WHERE ticket_id = $1 AND token_type = $2 AND is_used = FALSE
     AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [ticketId, tokenType]
  );

  if (existing.rows.length > 0) {
    return { token: existing.rows[0].token_plain, expiresAt: existing.rows[0].expires_at };
  }

  return createSecureToken(ticketId, tokenType, expiryHours);
}

module.exports = { generateSecureToken, hashToken, createSecureToken, validateSecureToken, markTokenUsed, getOrCreateToken };
