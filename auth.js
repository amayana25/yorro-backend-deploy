// ════════════════════════════════════════════════════════════
// YORRO Game-architect Studio — Authentification
// Email/mot de passe + Google Sign-In, sessions par JWT
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

function buildAuthRouter(User) {
  const router = express.Router();
  const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

  function signToken(user) {
    return jwt.sign(
      { yorroId: user.yorroId, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
  }

  function publicUser(user) {
    return {
      yorroId: user.yorroId,
      email: user.email,
      displayName: user.displayName,
      plan: user.plan,
    };
  }

  function generateYorroId() {
    return 'YORRO-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // ── INSCRIPTION EMAIL/MOT DE PASSE ──
  router.post('/register', async (req, res) => {
    try {
      const { email, password, displayName } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email et mot de passe requis' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });
      }
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        yorroId: generateYorroId(),
        email: email.toLowerCase(),
        passwordHash,
        displayName: displayName || email.split('@')[0],
      });
      res.json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
      console.error('Erreur register:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── CONNEXION EMAIL/MOT DE PASSE ──
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email et mot de passe requis' });
      }
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }
      res.json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
      console.error('Erreur login:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── CONNEXION GOOGLE ──
  // Le frontend utilise Google Identity Services et envoie le idToken obtenu.
  router.post('/google', async (req, res) => {
    try {
      if (!googleClient) {
        return res.status(503).json({ error: 'Connexion Google non configurée côté serveur (GOOGLE_CLIENT_ID manquant)' });
      }
      const { idToken } = req.body;
      if (!idToken) return res.status(400).json({ error: 'idToken manquant' });

      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();

      let user = await User.findOne({ googleId: payload.sub });
      if (!user) {
        // Peut-être un compte existant avec le même email (créé via mot de passe)
        user = await User.findOne({ email: payload.email.toLowerCase() });
        if (user) {
          user.googleId = payload.sub;
          await user.save();
        } else {
          user = await User.create({
            yorroId: generateYorroId(),
            email: payload.email.toLowerCase(),
            googleId: payload.sub,
            displayName: payload.name || payload.email.split('@')[0],
          });
        }
      }
      res.json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
      console.error('Erreur auth Google:', err);
      res.status(401).json({ error: 'Jeton Google invalide' });
    }
  });

  // ── PROFIL COURANT ──
  router.get('/me', authenticateUser(User), async (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
}

// ── MIDDLEWARE : vérifie le JWT et attache req.user (document Mongo complet) ──
function authenticateUser(User) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Non authentifié' });

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findOne({ yorroId: decoded.yorroId });
      if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });

      req.user = user;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Session invalide ou expirée — reconnectez-vous' });
    }
  };
}

module.exports = { buildAuthRouter, authenticateUser };
