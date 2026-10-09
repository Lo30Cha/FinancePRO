# Synchro bancaire (Crédit Agricole) : mise en route

L'app récupère tes opérations par **Enable Banking**, un prestataire agréé DSP2 qui donne accès en lecture seule aux comptes. La clé Enable Banking reste sur Supabase, dans la fonction `bank`. L'app n'envoie que ton jeton de connexion, et seul ton compte FinancePRO est autorisé.

Ces étapes se font une seule fois et prennent environ 15 minutes.

## 1. Enable Banking

1. Va sur https://enablebanking.com/sign-in/ et entre ton e-mail. Le compte se crée tout seul ; clique sur le lien reçu par e-mail.
2. Ouvre **API applications** (https://enablebanking.com/cp/applications), puis **Add a new application** :
   - **Environment** : `Production`
   - **Private key** : laisse l'option par défaut (la clé est générée dans le navigateur)
   - **Name** : `FinancePRO`
   - **Redirect URLs** : `https://lo30cha.github.io/FinancePRO/` (avec la barre finale, et exactement la même casse que l'adresse de l'app)
   - remplis les autres champs demandés (e-mail, description…).
3. Clique **Register**. Un fichier `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.pem` est téléchargé.
   - Le nom du fichier, sans `.pem`, est l'**identifiant de l'application**.
   - Garde ce fichier pour toi : c'est la clé privée.
4. L'application apparaît « Inactive ». Clique **Activate by linking accounts**, choisis **Crédit Agricole** puis ta caisse régionale, et valide dans l'app **Ma Banque**.
   - L'application passe en mode restreint : elle ne lit que les comptes que tu viens de lier. C'est gratuit pour un usage personnel.

## 2. Supabase

Ouvre le tableau de bord du projet (https://supabase.com/dashboard/project/bgzstllxojzdfjqktwyl).

1. **Ton identifiant** : *Authentication → Users*, copie l'**UID** de ton compte.
2. **La fonction** `bank` est déjà déployée. Pour la redéployer à la main : *Edge Functions → Deploy a new function → Via Editor*, nomme-la `bank`, colle le code de [`index.ts`](./index.ts), puis clique **Deploy function**.
3. **Les secrets** : *Edge Functions → Secrets*, ajoute :

| Nom | Valeur |
| --- | --- |
| `ENABLE_BANKING_APP_ID` | l'identifiant de l'application (nom du fichier .pem, sans `.pem`) |
| `ENABLE_BANKING_PRIVATE_KEY` | tout le contenu du fichier .pem, lignes `-----BEGIN…` et `-----END…` comprises |
| `ALLOWED_USER_IDS` | ton UID Supabase (plusieurs possibles, séparés par des virgules) |

`SUPABASE_URL` et `SUPABASE_ANON_KEY` sont fournis automatiquement.

`ALLOWED_ORIGINS` est optionnel. Par défaut il vaut `https://lo30cha.github.io` ; ajoute d'autres adresses, séparées par des virgules, si l'app est servie ailleurs.

Pour passer par la ligne de commande plutôt que par le tableau de bord :

```
supabase functions deploy bank --project-ref bgzstllxojzdfjqktwyl
supabase secrets set --project-ref bgzstllxojzdfjqktwyl ENABLE_BANKING_APP_ID=… ALLOWED_USER_IDS=…
supabase secrets set --project-ref bgzstllxojzdfjqktwyl ENABLE_BANKING_PRIVATE_KEY="$(cat ta-cle.pem)"
```

## 3. Dans l'app

1. *Réglages → Banque → Relier ma banque*.
2. Choisis ta caisse régionale et la date à partir de laquelle importer (par défaut, le 1er du mois). Touche **Continuer vers la banque**.
3. Valide dans **Ma Banque**. Tu reviens ensuite sur l'app.
   - Sur iPhone, le retour peut s'ouvrir dans Safari : connecte-toi si besoin, la liaison se termine là.
   - L'app installée la récupère ensuite par le cloud.

## Fonctionnement

- **Quand la synchro a lieu** : automatiquement à l'ouverture de l'app si la dernière date de plus de 6 h. La DSP2 limite à environ 4 accès par jour sans action de ta part. Le bouton **Synchroniser** (onglet Transactions) la lance à la demande.
- **Rien n'est ajouté sans ton accord.** À l'ouverture, la fenêtre **Opérations de la banque** s'ouvre d'elle-même s'il y a quelque chose à classer.
- **Seuls les jours vides sont proposés** : du lendemain de ta dernière saisie dans FinancePRO jusqu'à aujourd'hui (date de ton téléphone).
  - Les jours que tu as déjà renseignés ne sont jamais touchés, et leurs opérations bancaires ne sont pas proposées.
  - Les trous plus anciens sont ignorés.
  - Un jour sans opération à la banque est simplement sauté.
  - Les opérations du jour qui arrivent plus tard sont proposées à une ouverture suivante.
- **Date utilisée** : la date d'opération (celle du détail dans Ma Banque). Pour une carte, c'est la date d'achat écrite dans le libellé (« CARTE X1234 05/10 … »), pas la date de comptabilisation.
- **Ce qui est récupéré** : seules les opérations comptabilisées, pas les paiements « en cours ».
- **Pour chaque opération**, une catégorie est suggérée (règles d'import, puis tes anciennes transactions au même libellé) :
  - **Ajouter**, après avoir changé la catégorie si besoin ;
  - **Ignorer** : elle ne reviendra pas ;
  - **Tout ajouter** ;
  - **Plus tard** : elle reste en attente, et le bandeau de l'onglet Transactions affiche « N à vérifier ».
- **Récurrentes** : un prélèvement qui ressemble à une transaction récurrente déjà comptée (même montant, à 3 jours près) est signalé « Déjà comptée par la récurrente… ». *Tout ajouter* le laisse de côté.
- **Pas de doublons** : une opération ajoutée ou ignorée n'est jamais reproposée. Rien n'est écrasé ; la fusion cloud se fait opération par opération.
- **Livrets et épargne** : par défaut, l'app ne prend pas leurs opérations. Elle met à jour le solde du compte Patrimoine correspondant (c'est la seule valeur remplacée). L'usage de chaque compte se règle dans *Réglages → Banque*.
- **Renouvellement** : l'accès dure 90 à 180 jours selon la caisse. L'app prévient 14 jours avant. *Renouveler l'accès* refait la validation Ma Banque.
- **Délier** : supprime l'accès côté banque. Les opérations déjà ajoutées restent dans l'app.
