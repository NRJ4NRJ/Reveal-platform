# CHANGELOG — ITERATION 7

## Date : 2026-03-20

---

## 🔴 Corrections critiques

### Lancement des tests participant — vraies questions
- **`backend/src/routes/participant/index.ts`** : nouvelle route `GET /sessions/:id/next-question` qui récupère la vraie question depuis la DB selon `questionsAsked` de chaque progress item
- **`backend/src/routes/participant/index.ts`** : route `POST /sessions/:id/answer` mise à jour pour accepter `questionId` + `userAnswer` et calculer `isCorrect` côté backend
- **`frontend/src/pages/participant/Tests.tsx`** : réécriture complète du composant `TestRunner` — affichage réel des questions (QCM, Vrai/Faux, Ouvert, Scénario, Classement), feedback visuel, navigation automatique, timer

### Import Excel questions — types
- **`backend/src/routes/super-admin/questions.ts`** : `TYPE_MAP` étendu (Texte à trous, Vrai/Faux, Scénario, Question ouverte) + détection par sous-chaîne dans `normalizeType`

---

## 🟠 Corrections importantes

### Logo Super Admin sidebar
- **`frontend/src/components/Sidebar.tsx`** : suppression du guard `isSuperAdmin ? null` — `branding.logoUrl` utilisé pour tous les rôles

### Logo Admin Client pages login
- **`frontend/src/pages/Login.tsx`** : cache-busting sur l'URL du logo

### Traduction page login
- **`frontend/src/locales/fr.ts`** + **`en.ts`** : ajout clés `accessYourSpace`, `yourUsername`
- **`frontend/src/pages/Login.tsx`** : remplacement chaînes codées en dur par `t("clé")`

---

## 🟡 Corrections moyennes

### Filtrage tests par entreprise
- **`backend/src/routes/super-admin/tests.ts`** : inclusion `clientTests.client` dans le `findMany`

### Mapping sessions participant
- **`frontend/src/pages/participant/Tests.tsx`** : `session: a.test?.sessions?.[0]` dans `loadData()`

---

## 🔵 Nouvelles fonctionnalités

### Champs entreprise (code postal, ville, pays)
- **`backend/prisma/schema.prisma`** : ajout `postalCode`, `city`, `country` sur modèle `Client`
- **`backend/src/routes/super-admin/clients.ts`** : POST/PUT acceptent et sauvegardent ces champs
- **`backend/src/routes/admin/settings.ts`** : PUT accepte ces champs
- **`frontend/src/pages/super-admin/Clients.tsx`** : formulaires création/édition avec les 3 nouveaux champs

### Color picker + saisie hex
- **`frontend/src/pages/super-admin/Clients.tsx`** : inputs `type="color"` + `type="text"` hex synchronisés

### Language switcher toutes interfaces
- **`frontend/src/components/Sidebar.tsx`** : `LanguageSwitcher` ajouté en bas
- **`frontend/src/pages/participant/Sidebar.tsx`** : `LanguageSwitcher` ajouté

### Dashboard Admin — export Excel
- **`frontend/src/pages/admin/Dashboard.tsx`** : bouton "Télécharger les résultats" avec filtres

### Page Participant Messages
- **`frontend/src/pages/participant/Messages.tsx`** : nouvelle page messages participant
- **`frontend/src/App.tsx`** : route `/participant/messages` ajoutée

---

## Migration DB requise

Après déploiement, lancer :
```bash
docker compose --profile setup run --rm migrate
```
