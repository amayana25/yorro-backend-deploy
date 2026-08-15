// ════════════════════════════════════════════════════════════
// YORRO Studio — Proxy IA (clé API côté serveur)
// L'utilisateur n'a plus besoin de sa propre clé API.
// Quotas quotidiens (Redis) stricts par plan pour maîtriser le coût.
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════

const express = require('express');
const cache = require('./redis');

// Quotas quotidiens par plan. Ajustez selon votre budget.
const PLAN_QUOTAS = {
  free:  { chatPerDay: 15,  visionPerDay: 5,   maxTokens: 1024 },
  pro:   { chatPerDay: 300, visionPerDay: 100, maxTokens: 2048 },
  elite: { chatPerDay: Infinity, visionPerDay: Infinity, maxTokens: 4096 },
};

// Modèle NVIDIA utilisé quand provider === 'nvidia' (via NIM, API compatible OpenAI)
const NVIDIA_MODEL = 'minimaxai/minimax-m2.7';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// GLM-5.1 (Zhipu AI / Z.AI) — API officielle, compatible OpenAI
const GLM_MODEL = 'glm-5.1';
const GLM_BASE_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

function isAdminEmail(email) {
  return !!process.env.ADMIN_EMAIL && email &&
    email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
}

// Quota quotidien — compteurs stockés dans Redis (expiration automatique chaque jour)
async function checkAndConsumeQuota(user, kind) {
  // Accès admin illimité — vérifié par email exact côté serveur (jamais côté client)
  if (isAdminEmail(user.email)) {
    return { allowed: true, limit: Infinity, used: 0, maxTokens: PLAN_QUOTAS.elite.maxTokens };
  }

  const quota = PLAN_QUOTAS[user.plan] || PLAN_QUOTAS.free;
  const limit = kind === 'chat' ? quota.chatPerDay : quota.visionPerDay;

  const counts = await cache.getQuotaCounts(user.yorroId);
  const used = kind === 'chat' ? counts.chatCount : counts.visionCount;
  if (used >= limit) {
    return { allowed: false, limit, used };
  }

  const newUsed = await cache.incrementQuota(user.yorroId, kind);
  return { allowed: true, limit, used: newUsed, maxTokens: quota.maxTokens };
}

// Convertit des messages format Anthropic (content peut être une chaîne OU un tableau
// de blocs {type:'text'|'image', ...}) vers le format OpenAI/NVIDIA/GLM.
function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = m.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'image') {
          const url = `data:${block.source.media_type};base64,${block.source.data}`;
          return { type: 'image_url', image_url: { url } };
        }
        return null;
      }).filter(Boolean);
      out.push({ role: m.role, content: parts });
    }
  }
  return out;
}

async function callAnthropic({ messages, system, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens, system: system || undefined, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.error?.message || 'Erreur API Anthropic' };
  // Déjà au format {content:[{type:'text',text}]}
  return data;
}

async function callNvidia({ messages, system, maxTokens }) {
  if (!process.env.NVIDIA_API_KEY) {
    throw { status: 503, message: 'Modèle NVIDIA non configuré côté serveur (NVIDIA_API_KEY manquante)' };
  }
  const res = await fetch(NVIDIA_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({ model: NVIDIA_MODEL, max_tokens: maxTokens, messages: toOpenAIMessages(messages, system) }),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.error?.message || 'Erreur API NVIDIA' };
  const text = data.choices?.[0]?.message?.content || '';
  return { content: [{ type: 'text', text }] };
}

async function callGLM({ messages, system, maxTokens }) {
  if (!process.env.ZAI_API_KEY) {
    throw { status: 503, message: 'Modèle GLM non configuré côté serveur (ZAI_API_KEY manquante)' };
  }
  const res = await fetch(GLM_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ZAI_API_KEY}`,
    },
    body: JSON.stringify({ model: GLM_MODEL, max_tokens: maxTokens, messages: toOpenAIMessages(messages, system) }),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.error?.message || 'Erreur API GLM' };
  const text = data.choices?.[0]?.message?.content || '';
  return { content: [{ type: 'text', text }] };
}

const PROVIDER_CALLERS = { anthropic: callAnthropic, nvidia: callNvidia, glm: callGLM };

function buildAiRouter(authenticateUser) {
  const router = express.Router();

  // ── FOURNISSEURS DISPONIBLES (pour afficher le sélecteur côté frontend) ──
  router.get('/providers', authenticateUser, (req, res) => {
    res.json({
      providers: [
        { id: 'anthropic', name: 'Claude', available: !!process.env.ANTHROPIC_API_KEY },
        { id: 'nvidia', name: 'MiniMax M2.7 (NVIDIA)', available: !!process.env.NVIDIA_API_KEY },
        { id: 'glm', name: 'GLM-5.1 (Zhipu AI)', available: !!process.env.ZAI_API_KEY },
      ],
    });
  });

  // ── CHAT / GÉNÉRATION ──
  router.post('/chat', authenticateUser, async (req, res) => {
    try {
      const { messages, system, max_tokens, provider } = req.body;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages requis' });
      }

      const q = await checkAndConsumeQuota(req.user, 'chat');
      if (!q.allowed) {
        return res.status(429).json({
          error: `Quota quotidien atteint (${q.limit} messages/jour sur le plan ${req.user.plan}). Passez à un plan supérieur ou réessayez demain.`,
          quotaExceeded: true,
        });
      }

      const maxTokens = Math.min(max_tokens || q.maxTokens, q.maxTokens);
      const call = PROVIDER_CALLERS[provider] || callAnthropic;
      const data = await call({ messages, system, maxTokens });

      res.json({ ...data, quota: { used: q.used, limit: q.limit } });
    } catch (err) {
      console.error('Erreur /api/ai/chat:', err);
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
    }
  });

  // ── VISION (analyse d'image) ──
  // NB: reste sur Anthropic — ni MiniMax M2.7 (NVIDIA) ni GLM-5.1 n'ont de support vision ici.
  router.post('/vision', authenticateUser, async (req, res) => {
    try {
      const { image, mediaType, prompt, max_tokens } = req.body;
      if (!image || !prompt) {
        return res.status(400).json({ error: 'image et prompt requis' });
      }

      const q = await checkAndConsumeQuota(req.user, 'vision');
      if (!q.allowed) {
        return res.status(429).json({
          error: `Quota d'analyses image atteint (${q.limit}/jour sur le plan ${req.user.plan}).`,
          quotaExceeded: true,
        });
      }

      const data = await callAnthropic({
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
          { type: 'text', text: prompt },
        ] }],
        maxTokens: Math.min(max_tokens || 400, q.maxTokens),
      });

      res.json({ ...data, quota: { used: q.used, limit: q.limit } });
    } catch (err) {
      console.error('Erreur /api/ai/vision:', err);
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
    }
  });

  // ── ÉTAT DU QUOTA (pour afficher la barre côté frontend) ──
  router.get('/quota', authenticateUser, async (req, res) => {
    if (isAdminEmail(req.user.email)) {
      return res.json({ plan: 'elite', isAdmin: true, chat: { used: 0, limit: Infinity }, vision: { used: 0, limit: Infinity } });
    }
    const quota = PLAN_QUOTAS[req.user.plan] || PLAN_QUOTAS.free;
    const counts = await cache.getQuotaCounts(req.user.yorroId);
    res.json({
      plan: req.user.plan,
      chat: { used: counts.chatCount, limit: quota.chatPerDay },
      vision: { used: counts.visionCount, limit: quota.visionPerDay },
    });
  });

  return router;
}

module.exports = { buildAiRouter, PLAN_QUOTAS };
