const authService = require('../services/authService');
const { verifyRefreshToken } = require('../utils/jwt');
const { User } = require('../models');

async function register(req, res) {
  try {
    const { name, email, password } = req.body; // role is deliberately NOT read from the body
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    const user = await authService.register({ name, email, password });
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.login({ email, password });
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    if (err instanceof authService.InvalidCredentialsError) {
      return res.status(401).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
}

async function refresh(req, res) {
  try {
    const { refreshToken } = req.body;
    const { accessToken, refreshToken: newRefreshToken } = await authService.refresh(refreshToken);
    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    if (err instanceof authService.TokenRevokedError) {
      return res.status(401).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
}

// POST /api/auth/logout  { refreshToken }
// Works from the refresh token alone, so a user whose 15-minute access token
// has already expired can still log out and have their session revoked.
async function logout(req, res) {
  try {
    const { refreshToken } = req.body;
    try {
      const payload = verifyRefreshToken(refreshToken);
      await authService.logout(payload.sub, refreshToken);
    } catch (err) {
      // Invalid / expired token: there is nothing left to revoke.
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Logout failed' });
  }
}

// GET /api/auth/me - who am I? (front end uses this for the header and role-based menus)
async function me(req, res) {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load profile' });
  }
}

module.exports = { register, login, refresh, logout, me };