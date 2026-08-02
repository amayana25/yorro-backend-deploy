# Déploiement du backend YORRO — guide pas à pas

## Étape 1 — Base de données MongoDB (5 min)
1. Allez sur **mongodb.com/cloud/atlas** → créez un compte gratuit
2. **Build a Database** → choisissez l'offre **Free (M0)**
3. Créez un utilisateur de base de données (notez le nom d'utilisateur + mot de passe)
4. **Network Access** → **Add IP Address** → **Allow Access from Anywhere** (0.0.0.0/0)
5. **Database** → **Connect** → **Drivers** → copiez l'URI, qui ressemble à :
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/yorro?retryWrites=true&w=majority`
   Remplacez `<user>` et `<password>` par vos identifiants. **Gardez cette URI**, elle sert à `MONGODB_URI`.

## Étape 2 — Créer le dépôt GitHub du backend (2 min)
1. Sur GitHub : **New repository** → nommez-le par exemple `yorro-backend`
2. Poussez-y ces 7 fichiers (ceux que je vous ai livrés) : `server.js`, `auth.js`, `ai-proxy.js`, `signaling.js`, `phone-engine.js`, `package.json`, `render.yaml`

## Étape 3 — Déployer sur Render (5 min)
1. **render.com** → créez un compte (connexion via GitHub la plus simple)
2. **New** → **Blueprint**
3. Sélectionnez votre dépôt `yorro-backend` — Render détecte automatiquement `render.yaml`
4. Il vous demande de remplir les variables marquées `sync: false` :
   - **`MONGODB_URI`** → collez l'URI de l'étape 1 (**obligatoire**)
   - **`ANTHROPIC_API_KEY`** → votre clé API Anthropic (**obligatoire** — c'est elle qui sert tous vos utilisateurs). ⚠️ Mettez d'abord une limite de dépense mensuelle sur console.anthropic.com → Settings → Limits
   - `GOOGLE_CLIENT_ID` → optionnel, seulement si vous voulez activer "Connexion Google" (voir étape 4bis)
   - Les autres (Twilio, Telnyx, Africa's Talking, LiveKit, PayPal) → laissez vides pour l'instant, vous pourrez les ajouter plus tard un par un
5. **Apply** → Render construit et démarre le service (~2-3 min)
6. Une fois en ligne, notez l'URL donnée par Render, du type `https://yorro-backend.onrender.com`

## Étape 4 — Finaliser BACKEND_URL (1 min)
1. Retournez dans **Environment** sur Render → ajoutez/complétez `BACKEND_URL` avec l'URL notée à l'étape 3
2. Render redéploie automatiquement

## Étape 4bis (optionnel) — Activer "Connexion Google"
1. **console.cloud.google.com** → créez un projet → **APIs & Services → Credentials**
2. **Create Credentials → OAuth client ID** → type **Web application**
3. Dans **Authorized JavaScript origins**, ajoutez `https://yorrogame-archithecte.netlify.app`
4. Copiez le **Client ID** généré → ajoutez-le comme `GOOGLE_CLIENT_ID` sur Render
5. Collez ce même Client ID dans `index.html`, à la ligne `const GOOGLE_CLIENT_ID = '';`

## Étape 5 — Brancher le frontend sur ce backend (indispensable)
Dans `index.html`, tout en haut du script, remplacez :
```js
const YORRO_BACKEND = 'https://yorro-backend.onrender.com';
```
par l'URL réelle notée à l'étape 3. Repoussez sur GitHub → Netlify redéploie automatiquement.
**Sans cette étape, l'app pointe vers une URL qui n'existe pas et personne ne peut se connecter.**

## Étape 6 — Vérifier que ça marche
Ouvrez dans votre navigateur :
```
https://yorro-backend.onrender.com/api/phone/networks
```
Vous devriez voir une réponse JSON. Puis ouvrez votre app Netlify : l'écran de connexion doit s'afficher, créez un compte de test.

## Étape 7 (plus tard, à la carte) — Activer les vrais numéros de téléphone
Pour chaque réseau que vous voulez activer, créez le compte correspondant (Twilio, Telnyx, ou Africa's Talking), puis ajoutez ses variables dans **Render → Environment** — le service redémarre automatiquement et le réseau devient actif, sans rien changer côté frontend.

---
**Note sur le plan gratuit Render** : le service s'endort après 15 min d'inactivité et met ~30-50s à se réveiller au premier appel suivant. Pour un usage sérieux, passez au plan payant (~7$/mois) pour qu'il reste actif en permanence.

**Note sur les quotas IA** : réglables dans `ai-proxy.js`, objet `PLAN_QUOTAS` (messages/analyses par jour et par plan). Ajustez selon votre budget réel.

