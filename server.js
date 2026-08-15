// ════════════════════════════════════════════════════════════
// YORRO Game-architect Studio — Backend Serveur
// Express + Twilio + MongoDB + PayPal Webhooks
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const express       = require('express');
const cors          = require('cors');
const cookieParser  = require('cookie-parser');
const twilio        = require('twilio');
const crypto        = require('crypto');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const { router: phoneRouter, initPhoneEngine, assignNumberToUser } = require('./phone-engine');
const { initSignaling } = require('./signaling');
const { buildAuthRouter, authenticateUser } = require('./auth');
const { buildAiRouter } = require('./ai-proxy');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Railway/Render sont derrière un proxy — nécessaire pour un rate-limit fiable par IP
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// credentials:true + origin explicite (jamais '*') sont OBLIGATOIRES pour que
// le cookie de session httpOnly (faille #1) puisse être envoyé entre
// Netlify (frontend) et Railway (backend), qui sont deux domaines différents.
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// ════════════════════
// RATE LIMITING — protection anti-abus
// ════════════════════

// Limite globale, généreuse : évite le spam massif / scraping automatisé
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,                  // 300 requêtes / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes — réessayez dans quelques minutes.' },
});
app.use('/api/', globalLimiter);

// Limite stricte sur l'inscription/connexion : anti brute-force et anti création de comptes en masse
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                   // 10 tentatives / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion — réessayez dans 15 minutes.' },
  skipSuccessfulRequests: true, // ne compte que les échecs contre la limite
});
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);

// Limite modérée sur l'IA : filet de sécurité au-dessus du quota par plan
// (empêche les rafales rapides même pour un utilisateur qui n'a pas encore atteint son quota quotidien)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 15,             // 15 requêtes IA / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes IA en peu de temps — ralentissez un instant.' },
});
app.use('/api/ai/', aiLimiter);

// ── Healthcheck (Railway/Render vérifient cette route) ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'yorro-backend', timestamp: new Date().toISOString() });
});

// ── Module Téléphonie Multi-Réseau ──
app.use('/api/phone', phoneRouter);
initPhoneEngine();

// ════════════════════
// MODÈLES → voir db.js (PostgreSQL)
// ════════════════════
const db = require('./db');

// ── Connexion PostgreSQL (crée les tables si elles n'existent pas encore) ──
db.initSchema()
  .then(() => console.log('✅ PostgreSQL connecté'))
  .catch(err => console.error('❌ PostgreSQL:', err.message));

// ── Authentification (email/mdp + Google) ──
app.use('/api/auth', buildAuthRouter());

// ── Proxy IA (clé Anthropic côté serveur, quotas par plan) ──
app.use('/api/ai', buildAiRouter(authenticateUser));

// ════════════════════
// CONFIG TWILIO
// ════════════════════
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.warn('⚠️  Twilio non initialisé:', err.message);
  }
} else {
  console.log('ℹ️  Twilio non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN absents) — routes /api/call désactivées');
}

// Tarification ($ par minute)
const PRICING = {
  costPerMin:   0.02,   // Coût Twilio
  pricePerMin:  0.07,   // Prix facturé à l'utilisateur
  margin:       0.05,   // Votre marge par minute
};

// Packs de crédits
const PACKS = {
  starter:  { price: 2,  minutes: 20,  label: 'Starter'  },
  standard: { price: 5,  minutes: 60,  label: 'Standard' },
  pro:      { price: 10, minutes: 150, label: 'Pro'       },
  business: { price: 25, minutes: 500, label: 'Business' },
};

// Minutes incluses par plan mensuel
const PLAN_MINUTES = {
  free:  0,
  pro:   200,
  elite: 1000,
};

// ════════════════════
// MIDDLEWARE AUTH
// ════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers['x-yorro-token'];
  const yorroId = req.headers['x-yorro-id'];
  if (!token || !yorroId) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  // Vérifier token (simple hash en prod, JWT recommandé)
  const expected = crypto
    .createHmac('sha256', process.env.SECRET_KEY || 'yorro-secret')
    .update(yorroId)
    .digest('hex')
    .substring(0, 16);
  if (token !== expected) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  req.yorroId = yorroId;
  next();
}

// ════════════════════
// ROUTES UTILISATEUR
// ════════════════════

// Enregistrer / récupérer un utilisateur
app.post('/api/user/register', async (req, res) => {
  try {
    const { yorroId, email, plan } = req.body;
    let user = await db.getUserByYorroId(yorroId);
    if (!user) {
      user = await db.createUser({ yorroId, email, plan: plan || 'free' });
      // Créditer les minutes du plan
      user.credits = PLAN_MINUTES[plan] || 0;
      await user.save();
    }
    // Générer token
    const token = crypto
      .createHmac('sha256', process.env.SECRET_KEY || 'yorro-secret')
      .update(yorroId).digest('hex').substring(0, 16);
    res.json({ success: true, user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profil utilisateur + solde
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByYorroId(req.yorroId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({
      yorroId: user.yorroId,
      plan: user.plan,
      credits: user.credits,
      totalSpent: user.totalSpent,
      totalMinutes: user.totalMinutes,
      minutesLeft: user.credits,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// ROUTES APPELS
// ════════════════════

// Initier un appel vers un numéro mobile
app.post('/api/call/start', authMiddleware, async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(503).json({ error: 'Twilio non configuré côté serveur' });
    }
    const { to } = req.body;
    const user = await db.getUserByYorroId(req.yorroId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    // Vérifier solde minimum (1 minute)
    if (user.credits < 1) {
      return res.status(402).json({
        error: 'Solde insuffisant',
        credits: user.credits,
        action: 'recharge'
      });
    }

    // Valider le numéro
    if (!to || !to.startsWith('+')) {
      return res.status(400).json({ error: 'Numéro invalide — format international requis (+237...)' });
    }

    // Initier l'appel via Twilio
    const call = await twilioClient.calls.create({
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BACKEND_URL}/api/call/twiml`,
      statusCallback: `${process.env.BACKEND_URL}/api/call/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: false,
    });

    // Enregistrer l'appel en DB
    const callDoc = await db.createCall({
      yorroId: req.yorroId,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER,
      callSid: call.sid,
      status: 'initiated',
    });

    res.json({
      success: true,
      callSid: call.sid,
      callId: callDoc.id,
      creditsRemaining: user.credits,
      message: `Appel vers ${to} initié`
    });

  } catch (err) {
    console.error('Erreur appel:', err);
    res.status(500).json({ error: 'Erreur Twilio: ' + err.message });
  }
});

// TwiML — réponse Twilio pour l'appel
app.post('/api/call/twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: 'fr-FR', voice: 'alice' }, 'Appel YORRO. Connexion en cours.');
  twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    timeout: 30,
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

// Callback statut appel (appelé par Twilio)
app.post('/api/call/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    const callDoc = await db.getCallBySid(CallSid);
    if (!callDoc) return res.sendStatus(200);

    callDoc.status = CallStatus;

    if (CallStatus === 'completed' && CallDuration) {
      const durationSec = parseInt(CallDuration);
      const durationMin = Math.ceil(durationSec / 60); // Arrondi au-dessus
      const twilioC = durationMin * PRICING.costPerMin;
      const billed  = durationMin * PRICING.pricePerMin;

      callDoc.duration = durationSec;
      callDoc.cost     = twilioC;
      callDoc.billed   = billed;
      callDoc.endedAt  = new Date();

      // Déduire les minutes du solde utilisateur
      const user = await db.getUserByYorroId(callDoc.yorroId);
      if (user) {
        user.credits      = Math.max(0, user.credits - durationMin);
        user.totalMinutes += durationMin;
        await user.save();
      }
    }

    await callDoc.save();
    res.sendStatus(200);
  } catch (err) {
    console.error('Erreur status callback:', err);
    res.sendStatus(500);
  }
});

// Terminer un appel
app.post('/api/call/end', authMiddleware, async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(503).json({ error: 'Twilio non configuré côté serveur' });
    }
    const { callSid } = req.body;
    await twilioClient.calls(callSid).update({ status: 'completed' });
    res.json({ success: true, message: 'Appel terminé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historique des appels
app.get('/api/call/history', authMiddleware, async (req, res) => {
  try {
    const calls = await db.getCallsByYorroId(req.yorroId, 50);
    res.json({ calls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// ROUTES CRÉDITS
// ════════════════════

// Obtenir les packs disponibles
app.get('/api/credits/packs', (req, res) => {
  res.json({
    packs: Object.entries(PACKS).map(([key, pack]) => ({
      id: key,
      ...pack,
      marginPerMin: PRICING.margin,
      pricePerMin: PRICING.pricePerMin,
    })),
    pricing: PRICING,
  });
});

// Recharge manuelle (après paiement PayPal vérifié)
app.post('/api/credits/topup', authMiddleware, async (req, res) => {
  try {
    const { pack, paypalOrderId } = req.body;
    const packData = PACKS[pack];
    if (!packData) return res.status(400).json({ error: 'Pack invalide' });

    const user = await db.getUserByYorroId(req.yorroId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    // Enregistrer transaction
    await db.createTransaction({
      yorroId: req.yorroId,
      type: 'topup',
      amount: packData.price,
      minutes: packData.minutes,
      paypalOrderId,
      status: 'completed',
      pack,
    });

    // Créditer les minutes
    user.credits    += packData.minutes;
    user.totalSpent += packData.price;
    await user.save();

    res.json({
      success: true,
      credited: packData.minutes,
      newBalance: user.credits,
      message: `${packData.minutes} minutes créditées !`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// VÉRIFICATION ABONNEMENT PAYPAL (appelée par le frontend après onApprove)
// ════════════════════
const SUBSCRIPTION_PRICES = { pro: 9.99, elite: 24.99 };

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const base = process.env.PAYPAL_ENV === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Impossible d\'obtenir un token PayPal');
  return { token: data.access_token, base };
}

// Le frontend envoie l'orderID PayPal + le plan choisi APRÈS le paiement.
// On revérifie ici auprès de PayPal (jamais confiance au seul navigateur)
// avant de débloquer réellement le plan.
app.post('/api/paypal/verify-order', async (req, res) => {
  try {
    const { orderID, planId, yorroId } = req.body;
    if (!orderID || !planId || !yorroId) {
      return res.status(400).json({ error: 'orderID, planId et yorroId requis' });
    }
    const expectedPrice = SUBSCRIPTION_PRICES[planId];
    if (!expectedPrice) {
      return res.status(400).json({ error: 'Plan invalide' });
    }
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Vérification PayPal non configurée côté serveur (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET manquants)' });
    }

    const { token, base } = await getPayPalAccessToken();
    const orderRes = await fetch(`${base}/v2/checkout/orders/${orderID}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const order = await orderRes.json();

    const paidAmount = parseFloat(order.purchase_units?.[0]?.amount?.value || 0);
    const isCompleted = order.status === 'COMPLETED';
    const amountOk = Math.abs(paidAmount - expectedPrice) < 0.01;

    if (!isCompleted || !amountOk) {
      return res.status(402).json({
        verified: false,
        error: !isCompleted ? 'Paiement non complété côté PayPal' : 'Montant payé ne correspond pas au plan',
      });
    }

    // Paiement confirmé -> on met à jour l'utilisateur et on enregistre la transaction
    let user = await db.getUserByYorroId(yorroId);
    if (!user) user = await db.createUser({ yorroId, plan: planId });
    user.plan = planId;
    user.totalSpent += expectedPrice;
    await user.save();

    await db.createTransaction({
      yorroId,
      type: 'subscription',
      amount: expectedPrice,
      paypalOrderId: orderID,
      status: 'completed',
      pack: planId,
    });

    // Attribution automatique d'un numéro dédié (Pro/Elite uniquement)
    let assignedNumber = null;
    try {
      assignedNumber = await assignNumberToUser(yorroId);
    } catch (err) {
      console.warn('⚠️  Attribution de numéro échouée pour', yorroId, ':', err.message);
      // On ne bloque jamais la confirmation du paiement pour ça — l'utilisateur
      // garde son plan payant même si aucun numéro n'a pu être attribué tout de suite.
    }

    res.json({ verified: true, plan: planId, assignedNumber });
  } catch (err) {
    console.error('Erreur verify-order PayPal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// PAYPAL WEBHOOK
// ════════════════════
app.post('/api/paypal/webhook', async (req, res) => {
  try {
    const event = req.body;
    // Vérifier que le paiement est complété
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event.resource.supplementary_data?.related_ids?.order_id;
      const amount  = parseFloat(event.resource.amount?.value || 0);
      // Trouver la transaction en attente
      const tx = await db.getPendingTransactionByOrderId(orderId);
      if (tx) {
        tx.status = 'completed';
        await tx.save();
        // Créditer automatiquement
        const user = await db.getUserByYorroId(tx.yorroId);
        if (user) {
          user.credits    += tx.minutes;
          user.totalSpent += tx.amount;
          await user.save();
          console.log(`✅ ${tx.minutes} min créditées à ${tx.yorroId}`);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook PayPal:', err);
    res.sendStatus(500);
  }
});

// ════════════════════
// DASHBOARD REVENUS (Admin Patrick)
// ════════════════════
app.get('/api/admin/dashboard', async (req, res) => {
  // Sécuriser avec clé admin
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Accès admin refusé' });
  }
  try {
    const [
      totalUsers,
      totalCalls,
      totalTransactions,
      recentCalls,
      recentTransactions,
    ] = await Promise.all([
      db.countUsers(),
      db.countCompletedCalls(),
      db.countCompletedTransactions(),
      db.getRecentCompletedCalls(10),
      db.getRecentCompletedTransactions(10),
    ]);

    // Calcul revenus
    const totalRevenue = await db.sumCompletedTransactionAmount();

    // Coût Twilio estimé
    const twilioStats = await db.getCompletedCallStats();

    res.json({
      summary: {
        totalUsers,
        totalCalls,
        totalTransactions,
        totalRevenue: totalRevenue.toFixed(2),
        twilioMins: Math.round(twilioStats.totalMinutes),
        twilioCost: twilioStats.totalCost.toFixed(2),
        netProfit:  (totalRevenue - twilioStats.totalCost).toFixed(2),
        margin:     totalRevenue > 0
          ? ((1 - twilioStats.totalCost / totalRevenue) * 100).toFixed(1) + '%'
          : '0%',
      },
      recentCalls: recentCalls.map(c => ({
        to: c.to,
        duration: c.duration + 's',
        cost: '$' + c.cost.toFixed(3),
        billed: '$' + c.billed.toFixed(3),
        profit: '$' + (c.billed - c.cost).toFixed(3),
        date: c.startedAt,
      })),
      recentTransactions: recentTransactions.map(t => ({
        yorroId: t.yorroId,
        pack: t.pack,
        amount: '$' + t.amount,
        minutes: t.minutes + ' min',
        date: t.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Santé du serveur ──
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'YORRO Game-architect Backend',
    owner: 'Patrick Emessiene Amayna',
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 3001;
const http = require('http');
const httpServer = http.createServer(app);

// ── Signalisation WebRTC (WebSocket) ──
initSignaling(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 YORRO Backend démarré sur le port ${PORT}`);
  console.log(`   © Patrick Emessiene Amayna`);
});

module.exports = app;
