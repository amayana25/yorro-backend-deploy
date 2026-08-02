// ════════════════════════════════════════════════════════════
// YORRO Game-architect Studio — Backend Serveur
// Express + Twilio + MongoDB + PayPal Webhooks
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const mongoose   = require('mongoose');
const twilio     = require('twilio');
const crypto     = require('crypto');
const { router: phoneRouter, initPhoneEngine } = require('./phone-engine');
const { initSignaling } = require('./signaling');
const { buildAuthRouter, authenticateUser } = require('./auth');
const { buildAiRouter } = require('./ai-proxy');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// ── Module Téléphonie Multi-Réseau ──
app.use('/api/phone', phoneRouter);
initPhoneEngine();

// ── Connexion MongoDB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB:', err));

// ════════════════════
// MODÈLES
// ════════════════════

// Utilisateur YORRO
const UserSchema = new mongoose.Schema({
  yorroId:      { type: String, unique: true, required: true },
  email:        { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String },              // absent si connexion Google uniquement
  googleId:     { type: String, unique: true, sparse: true },
  displayName:  { type: String },
  plan:         { type: String, default: 'free' },   // free | pro | elite
  credits:      { type: Number, default: 0 },        // minutes disponibles
  totalSpent:   { type: Number, default: 0 },        // $ dépensés
  totalMinutes: { type: Number, default: 0 },        // minutes utilisées
  quota: {
    date:       { type: String, default: '' },  // YYYY-MM-DD du jour en cours de comptage
    chatCount:  { type: Number, default: 0 },
    visionCount:{ type: Number, default: 0 },
  },
  createdAt:    { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

// ── Authentification (email/mdp + Google) ──
const authJWT = authenticateUser(User);
app.use('/api/auth', buildAuthRouter(User));

// ── Proxy IA (clé Anthropic côté serveur, quotas par plan) ──
app.use('/api/ai', buildAiRouter(authJWT));

// Appel téléphonique
const CallSchema = new mongoose.Schema({
  yorroId:    { type: String, required: true },
  to:         { type: String, required: true },
  from:       { type: String },
  callSid:    { type: String },              // SID Twilio
  status:     { type: String, default: 'initiated' },
  duration:   { type: Number, default: 0 }, // secondes
  cost:       { type: Number, default: 0 }, // $ coût Twilio
  billed:     { type: Number, default: 0 }, // $ facturé au client
  type:       { type: String, default: 'outbound' },
  startedAt:  { type: Date, default: Date.now },
  endedAt:    { type: Date },
});
const Call = mongoose.model('Call', CallSchema);

// Transaction / Paiement
const TransactionSchema = new mongoose.Schema({
  yorroId:       { type: String, required: true },
  type:          { type: String },  // topup | subscription | refund
  amount:        { type: Number },  // $ reçus
  minutes:       { type: Number },  // minutes créditées
  paypalOrderId: { type: String },
  status:        { type: String, default: 'pending' },
  pack:          { type: String },  // starter | standard | pro | business
  createdAt:     { type: Date, default: Date.now },
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ════════════════════
// CONFIG TWILIO
// ════════════════════
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
    let user = await User.findOne({ yorroId });
    if (!user) {
      user = await User.create({ yorroId, email, plan: plan || 'free' });
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
    const user = await User.findOne({ yorroId: req.yorroId });
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
    const { to } = req.body;
    const user = await User.findOne({ yorroId: req.yorroId });
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
    const callDoc = await Call.create({
      yorroId: req.yorroId,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER,
      callSid: call.sid,
      status: 'initiated',
    });

    res.json({
      success: true,
      callSid: call.sid,
      callId: callDoc._id,
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
    const callDoc = await Call.findOne({ callSid: CallSid });
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
      const user = await User.findOne({ yorroId: callDoc.yorroId });
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
    const calls = await Call.find({ yorroId: req.yorroId })
      .sort({ startedAt: -1 }).limit(50);
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

    const user = await User.findOne({ yorroId: req.yorroId });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    // Enregistrer transaction
    await Transaction.create({
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
    let user = await User.findOne({ yorroId });
    if (!user) user = await User.create({ yorroId, plan: planId });
    user.plan = planId;
    user.totalSpent += expectedPrice;
    await user.save();

    await Transaction.create({
      yorroId,
      type: 'subscription',
      amount: expectedPrice,
      paypalOrderId: orderID,
      status: 'completed',
      pack: planId,
    });

    res.json({ verified: true, plan: planId });
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
      const tx = await Transaction.findOne({ paypalOrderId: orderId, status: 'pending' });
      if (tx) {
        tx.status = 'completed';
        await tx.save();
        // Créditer automatiquement
        const user = await User.findOne({ yorroId: tx.yorroId });
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
      User.countDocuments(),
      Call.countDocuments({ status: 'completed' }),
      Transaction.countDocuments({ status: 'completed' }),
      Call.find({ status: 'completed' }).sort({ startedAt: -1 }).limit(10),
      Transaction.find({ status: 'completed' }).sort({ createdAt: -1 }).limit(10),
    ]);

    // Calcul revenus
    const revenueAgg = await Transaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalRevenue = revenueAgg[0]?.total || 0;

    // Coût Twilio estimé
    const minutesAgg = await Call.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, totalMin: { $sum: { $divide: ['$duration', 60] } }, totalCost: { $sum: '$cost' } } }
    ]);
    const twilioStats = minutesAgg[0] || { totalMin: 0, totalCost: 0 };

    res.json({
      summary: {
        totalUsers,
        totalCalls,
        totalTransactions,
        totalRevenue: totalRevenue.toFixed(2),
        twilioMins: Math.round(twilioStats.totalMin),
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
