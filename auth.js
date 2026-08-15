// ════════════════════════════════════════════════════════════
// YORRO Studio — Authentification (PostgreSQL + Redis)
// Email/mot de passe + Google Sign-In, sessions par cookie httpOnly,
// vérification d'email, mots de passe fuités bloqués, 2FA (TOTP).
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const cache = require('./redis');
const { isPasswordBreached, generateTotpSecret, verifyTotpCode, totpAuthUri, sendVerificationEmail } = require('./security');

const SESSION_COOKIE = 'yorro_session';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

function buildAuthRouter() {
  const router = express.Router();
  const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

  function signToken(user) {
    return jwt.sign({ yorroId: user.yorroId, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  }

  function setSessionCookie(res, user) {
    res.cookie(SESSION_COOKIE, signToken(user), COOKIE_OPTIONS);
  }

  function isAdminEmail(email) {
    return !!process.env.ADMIN_EMAIL && email &&
      email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
  }

  function publicUser(user) {
    const admin = isAdminEmail(user.email);
    return {
      yorroId: user.yorroId,
      email: user.email,
      displayName: user.displayName,
      plan: admin ? 'elite' : user.plan,
      isAdmin: admin,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  }

  function generateYorroId() {
    return 'YORRO-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  router.post('/register', async (req, res) => {
    try {
      const { email, password, displayName } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
      if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });

      const breached = await isPasswordBreached(password);
      if (breached) {
        return res.status(400).json({ error: 'Ce mot de passe est apparu dans une fuite de données connue. Choisissez-en un autre, unique à ce site.' });
      }

      const existing = await db.getUserByEmail(email.toLowerCase());
      if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });

      const passwordHash = await bcrypt.hash(password, 10);
      const emailVerifyToken = crypto.randomBytes(32).toString('hex');
      const user = await db.createUser({
        yorroId: generateYorroId(),
        email: email.toLowerCase(),
        passwordHash,
        displayName: displayName || email.split('@')[0],
        emailVerifyToken,
        emailVerifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      await sendVerificationEmail(user.email, emailVerifyToken);
      setSessionCookie(res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error('Erreur register:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { email, password, code } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

      const user = await db.getUserByEmail(email.toLowerCase());
      if (!user || !user.passwordHash) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      if (user.twoFactorEnabled) {
        if (!code) return res.status(200).json({ requires2FA: true });
        if (!verifyTotpCode(user.twoFactorSecret, code)) return res.status(401).json({ error: 'Code de vérification incorrect' });
      }

      setSessionCookie(res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error('Erreur login:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/google', async (req, res) => {
    try {
      if (!googleClient) return res.status(503).json({ error: 'Connexion Google non configurée côté serveur (GOOGLE_CLIENT_ID manquant)' });
      const { idToken, code } = req.body;
      if (!idToken) return res.status(400).json({ error: 'idToken manquant' });

      const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();

      let user = await db.getUserByGoogleId(payload.sub);
      if (!user) {
        user = await db.getUserByEmail(payload.email.toLowerCase());
        if (user) {
          user.googleId = payload.sub;
          await user.save();
        } else {
          user = await db.createUser({
            yorroId: generateYorroId(),
            email: payload.email.toLowerCase(),
            googleId: payload.sub,
            displayName: payload.name || payload.email.split('@')[0],
            emailVerified: true,
          });
        }
      }

      if (user.twoFactorEnabled) {
        if (!code) return res.status(200).json({ requires2FA: true });
        if (!verifyTotpCode(user.twoFactorSecret, code)) return res.status(401).json({ error: 'Code de vérification incorrect' });
      }

      setSessionCookie(res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error('Erreur auth Google:', err);
      res.status(401).json({ error: 'Jeton Google invalide' });
    }
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
    res.json({ success: true });
  });

  router.get('/verify-email', async (req, res) => {
    try {
      const { token } = req.query;
      const user = await db.getUserByValidVerifyToken(token);
      if (!user) return res.status(400).json({ error: 'Lien invalide ou expiré' });

      user.emailVerified = true;
      user.emailVerifyToken = null;
      user.emailVerifyExpires = null;
      await user.save();
      await cache.invalidateUserCache(user.yorroId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/resend-verification', authenticateUser, async (req, res) => {
    if (req.user.emailVerified) return res.json({ success: true, alreadyVerified: true });
    const token = crypto.randomBytes(32).toString('hex');
    req.user.emailVerifyToken = token;
    req.user.emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await req.user.save();
    await cache.invalidateUserCache(req.user.yorroId);
    const result = await sendVerificationEmail(req.user.email, token);
    res.json({ success: true, emailSent: result.sent });
  });

  router.post('/2fa/setup', authenticateUser, async (req, res) => {
    const secret = generateTotpSecret();
    req.user.twoFactorTempSecret = secret;
    await req.user.save();
    await cache.invalidateUserCache(req.user.yorroId);
    res.json({ secret, otpauthUri: totpAuthUri(secret, req.user.email) });
  });

  router.post('/2fa/confirm', authenticateUser, async (req, res) => {
    const { code } = req.body;
    if (!req.user.twoFactorTempSecret) return res.status(400).json({ error: 'Aucune activation 2FA en cours — relancez /2fa/setup' });
    if (!verifyTotpCode(req.user.twoFactorTempSecret, code)) return res.status(400).json({ error: 'Code incorrect' });

    req.user.twoFactorSecret = req.user.twoFactorTempSecret;
    req.user.twoFactorTempSecret = null;
    req.user.twoFactorEnabled = true;
    await req.user.save();
    await cache.invalidateUserCache(req.user.yorroId);
    res.json({ success: true });
  });

  router.post('/2fa/disable', authenticateUser, async (req, res) => {
    const { password } = req.body;
    if (req.user.passwordHash) {
      const ok = await bcrypt.compare(password || '', req.user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    req.user.twoFactorEnabled = false;
    req.user.twoFactorSecret = null;
    await req.user.save();
    await cache.invalidateUserCache(req.user.yorroId);
    res.json({ success: true });
  });

  router.get('/me', authenticateUser, async (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
}

// ── MIDDLEWARE : vérifie la session (cookie httpOnly), avec cache Redis ──
async function authenticateUser(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let user = await cache.getCachedUser(decoded.yorroId);
    if (!user) {
      user = await db.getUserByYorroId(decoded.yorroId);
      if (user) await cache.cacheUser(decoded.yorroId, user);
    } else {
      user.save = () => db.saveUser(user); // reattacher .save() (perdu lors du JSON.stringify du cache)
    }
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session invalide ou expirée — reconnectez-vous' });
  }
}

module.exports = { buildAuthRouter, authenticateUser };
