// ════════════════════════════════════════════════════════════
// YORRO Game-architect Studio — Moteur Téléphonie Multi-Réseau
// Routes : /api/phone/smart-call, /api/phone/livekit/token
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════
//
// Ce module choisit automatiquement le réseau d'appel le moins
// cher parmi ceux configurés (variables d'environnement présentes),
// ou utilise le réseau demandé explicitement par le client
// (preferredNetwork). Il reproduit les coûts/labels utilisés
// côté frontend (NET_COSTS / NET_LABELS dans index.html).

const express = require('express');
const router = express.Router();

// ── Coût par minute (doit rester cohérent avec NET_COSTS côté frontend) ──
const NETWORK_COST_PER_MIN = {
  sip: 0.001,
  telnyx: 0.002,
  africastalking: 0.004,
  twilio: 0.02,
};

// Ordre de préférence pour le mode "auto" : du moins cher au plus cher
const AUTO_ORDER = ['sip', 'telnyx', 'africastalking', 'twilio'];

// ════════════════════
// ÉTAT DES PROVIDERS (initialisé dans initPhoneEngine)
// ════════════════════
const providers = {
  twilio:         { configured: false, client: null },
  telnyx:         { configured: false, client: null },
  africastalking: { configured: false, client: null },
  sip:            { configured: false }, // pas de SDK dédié pour l'instant
  livekit:        { configured: false },
};

// ════════════════════
// INITIALISATION
// ════════════════════
function initPhoneEngine() {
  // ── Twilio ──
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilio = require('twilio');
      providers.twilio.client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      providers.twilio.configured = true;
    } catch (err) {
      console.warn('⚠️  [phone-engine] Twilio non initialisé:', err.message);
    }
  }

  // ── Telnyx ──
  if (process.env.TELNYX_API_KEY) {
    try {
      const Telnyx = require('telnyx');
      providers.telnyx.client = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
      providers.telnyx.configured = true;
    } catch (err) {
      console.warn('⚠️  [phone-engine] Telnyx non initialisé:', err.message);
    }
  }

  // ── Africa's Talking ──
  if (process.env.AT_USERNAME && process.env.AT_API_KEY) {
    try {
      const AfricasTalking = require('africastalking');
      providers.africastalking.client = AfricasTalking({
        username: process.env.AT_USERNAME,
        apiKey: process.env.AT_API_KEY,
      });
      providers.africastalking.configured = true;
    } catch (err) {
      console.warn("⚠️  [phone-engine] Africa's Talking non initialisé:", err.message);
    }
  }

  // ── SIP / Asterisk ── (nécessite un pont AMI/ARI externe, non inclus)
  if (process.env.SIP_SERVER && process.env.SIP_USER && process.env.SIP_PASSWORD) {
    providers.sip.configured = true;
  }

  // ── LiveKit ──
  if (process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) {
    providers.livekit.configured = true;
  }

  const active = Object.entries(providers)
    .filter(([, p]) => p.configured)
    .map(([name]) => name);

  console.log(
    active.length
      ? `📞 [phone-engine] Réseaux actifs: ${active.join(', ')}`
      : '📞 [phone-engine] Aucun réseau configuré — définissez les variables d\'environnement (voir phone-engine.js)'
  );
}

// ════════════════════
// APPELS PAR RÉSEAU
// ════════════════════

async function callViaTwilio(to) {
  if (!providers.twilio.configured) throw new Error('Twilio non configuré');
  const call = await providers.twilio.client.calls.create({
    to,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `${process.env.BACKEND_URL}/api/call/twiml`,
    statusCallback: `${process.env.BACKEND_URL}/api/call/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });
  return { network: 'twilio', callId: call.sid };
}

async function callViaTelnyx(to) {
  if (!providers.telnyx.configured) throw new Error('Telnyx non configuré');
  const call = await providers.telnyx.client.calls.create({
    connection_id: process.env.TELNYX_CONNECTION_ID,
    to,
    from: process.env.TELNYX_FROM_NUMBER,
  });
  return { network: 'telnyx', callId: call.data?.call_control_id || call.id };
}

async function callViaAfricasTalking(to) {
  if (!providers.africastalking.configured) throw new Error("Africa's Talking non configuré");
  const voice = providers.africastalking.client.VOICE;
  const result = await voice.call({
    callFrom: process.env.AT_PHONE_NUMBER,
    callTo: to,
  });
  return { network: 'africastalking', callId: result?.entries?.[0]?.sessionId || 'unknown' };
}

async function callViaSip(to) {
  // Nécessite une intégration Asterisk AMI/ARI (non incluse ici).
  // À implémenter selon votre PABX (ex: paquet 'asterisk-manager' + dialplan).
  throw new Error('SIP/Asterisk pas encore implémenté côté serveur');
}

const NETWORK_HANDLERS = {
  twilio: callViaTwilio,
  telnyx: callViaTelnyx,
  africastalking: callViaAfricasTalking,
  sip: callViaSip,
};

// ════════════════════
// ROUTE : POST /api/phone/smart-call
// ════════════════════
router.post('/smart-call', async (req, res) => {
  try {
    const { to, preferredNetwork, yorroId } = req.body;

    if (!to || !to.startsWith('+')) {
      return res.status(400).json({ error: 'Numéro invalide — format international requis (+237...)' });
    }
    if (!yorroId) {
      return res.status(400).json({ error: 'yorroId manquant' });
    }

    // Construire la liste des réseaux à essayer, dans l'ordre
    let order;
    if (preferredNetwork && preferredNetwork !== 'auto' && NETWORK_HANDLERS[preferredNetwork]) {
      order = [preferredNetwork, ...AUTO_ORDER.filter(n => n !== preferredNetwork)];
    } else {
      order = AUTO_ORDER;
    }

    const errors = [];
    for (const network of order) {
      if (!providers[network]?.configured) continue;
      try {
        const result = await NETWORK_HANDLERS[network](to);
        return res.json({
          success: true,
          selectedNetwork: result.network,
          callId: result.callId,
          routing: {
            costPerMin: NETWORK_COST_PER_MIN[network].toString().replace('.', ','),
            requested: preferredNetwork || 'auto',
          },
          message: `Appel vers ${to} initié via ${result.network}`,
        });
      } catch (err) {
        errors.push(`${network}: ${err.message}`);
      }
    }

    return res.status(503).json({
      error: 'Aucun réseau disponible n\'a pu établir l\'appel',
      details: errors.length ? errors : ['Aucun réseau configuré côté serveur'],
    });
  } catch (err) {
    console.error('Erreur smart-call:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// ROUTE : POST /api/phone/livekit/token
// ════════════════════
router.post('/livekit/token', async (req, res) => {
  try {
    if (!providers.livekit.configured) {
      return res.status(503).json({ error: 'LiveKit non configuré côté serveur (LIVEKIT_API_KEY / LIVEKIT_API_SECRET manquants)' });
    }

    const { roomName, participantName, participantId } = req.body;
    if (!roomName) {
      return res.status(400).json({ error: 'roomName manquant' });
    }

    const { AccessToken } = require('livekit-server-sdk');
    const identity = participantId || participantName || `user-${Date.now()}`;

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity,
      name: participantName || identity,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();

    res.json({
      success: true,
      token,
      url: process.env.LIVEKIT_URL || null,
      roomName,
    });
  } catch (err) {
    console.error('Erreur livekit/token:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════
// ROUTE : GET /api/phone/networks — utilitaire de diagnostic
// ════════════════════
router.get('/networks', (req, res) => {
  res.json({
    networks: Object.entries(providers).map(([name, p]) => ({
      name,
      configured: p.configured,
      costPerMin: NETWORK_COST_PER_MIN[name] ?? 0,
    })),
  });
});

module.exports = { router, initPhoneEngine };
