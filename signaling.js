// ════════════════════════════════════════════════════════════
// YORRO Game-architect Studio — Signalisation WebRTC (WebSocket)
// Relaie les offres/réponses SDP et les candidats ICE entre
// deux utilisateurs YORRO pour établir un vrai appel WebRTC P2P.
// © Patrick Emessiene Amayna — Tous droits réservés
// ════════════════════════════════════════════════════════════
//
// Protocole (messages JSON) :
//   Client -> Serveur : { type:'register', id }
//   Client -> Serveur : { type:'call',     to, from, offer }
//   Client -> Serveur : { type:'answer',   to, from, answer }
//   Client -> Serveur : { type:'ice',      to, from, candidate }
//   Client -> Serveur : { type:'hangup',   to, from }
//
//   Serveur -> Client : { type:'registered', id }
//   Serveur -> Client : { type:'call',    from, offer }
//   Serveur -> Client : { type:'answer',  from, answer }
//   Serveur -> Client : { type:'ice',     from, candidate }
//   Serveur -> Client : { type:'hangup',  from }
//   Serveur -> Client : { type:'error',   message, code }

const { WebSocketServer } = require('ws');

// id YORRO -> socket WebSocket actif
const connections = new Map();

function initSignaling(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/signaling' });

  wss.on('connection', (ws) => {
    let myId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return ws.send(JSON.stringify({ type: 'error', message: 'JSON invalide' }));
      }

      switch (msg.type) {
        case 'register': {
          if (!msg.id) return ws.send(JSON.stringify({ type: 'error', message: 'id manquant' }));
          myId = msg.id;
          connections.set(myId, ws);
          ws.send(JSON.stringify({ type: 'registered', id: myId }));
          console.log(`🔌 [signaling] ${myId} connecté (${connections.size} en ligne)`);
          break;
        }

        case 'call':
        case 'answer':
        case 'ice':
        case 'hangup': {
          const target = connections.get(msg.to);
          if (!target || target.readyState !== target.OPEN) {
            return ws.send(JSON.stringify({
              type: 'error',
              code: 'peer-offline',
              message: `${msg.to} n'est pas en ligne`,
            }));
          }
          // Relayer tel quel au destinataire (offer / answer / candidate)
          target.send(JSON.stringify(msg));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Type de message inconnu: ' + msg.type }));
      }
    });

    ws.on('close', () => {
      if (myId) {
        connections.delete(myId);
        console.log(`🔌 [signaling] ${myId} déconnecté (${connections.size} en ligne)`);
      }
    });
  });

  console.log('📡 [signaling] Serveur WebSocket prêt sur /ws/signaling');
  return wss;
}

module.exports = { initSignaling };
