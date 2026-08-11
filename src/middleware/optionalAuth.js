const { authenticate } = require('./auth');

// Attaches req.user when a valid session token is present, but does NOT
// reject unauthenticated requests. Used on endpoints that must keep working
// for the legacy/public web caller while allowing authenticated (mobile)
// callers to be identified (e.g. recording who created a ticket).
const optionalAuth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.session_token;
  if (!token) return next();
  return authenticate(req, res, next);
};

module.exports = { optionalAuth };
