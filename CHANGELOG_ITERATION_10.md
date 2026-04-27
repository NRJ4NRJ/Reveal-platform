# Changelog — Iteration 10

**Date** : 2026-04-03

## Priorité 🔴 Critique

### Logique de test par niveau (backend)
- Nouvelle progression : Fondamental → Basique → Intermédiaire → Avancé → Complet
- 2 bonnes réponses au niveau courant → passage au niveau supérieur
- 3 tentatives sans 2 bonnes → arrêt du sous-thème
- Questions sélectionnées aléatoirement au niveau courant
- `levelReached` stocké par SST dans `TestSessionProgress`

### Scoring par niveau (backend)
- Fondamental = 1 pt, Basique = 2 pts, Intermédiaire = 3 pts, Avancé = 4 pts, Complet = 5 pts
- `pointsEarned` et `maxPoints` stockés dans `TestSessionProgress`
- `customScore` sur la question pour surcharge manuelle

### Schema Prisma
- `TestSessionProgress` : ajout `levelQuestionsAsked`, `levelCorrectCount`, `levelReached`, `pointsEarned`, `maxPoints`
- `Question` : ajout `customScore Int?`
- `Client` : ajout `state String?` (état US)
- `User` : ajout `pendingEmail`, `emailVerificationToken`

## Priorité 🟠 Important

### i18n Sidebar
- Labels de navigation traduits dynamiquement via `t()` pour SA et AC
- Bouton "Déconnexion" et "Réduire" traduits

### Super Admin Settings : changement e-mail
- Nouveau formulaire : nouvelle adresse + confirmation par mot de passe
- Route backend `PUT /api/super-admin/platform-settings/email`
- Validation format email côté front et back

### Banque de questions : score
- Affichage du score (barème auto ou custom) sur chaque question
- Champ d'édition du score dans le formulaire question

### Réponses à analyser : score basé sur niveau
- Score max calculé selon le niveau de la question (1-5)
- Input borné entre 0 et le max du niveau

### Menu pays + états US (Clients SA)
- Dropdown pays avec 28 pays courants
- Dropdown états US conditionnel (50 états + territoires)

## Priorité 🟡 Feature

### Dashboard Admin Client : graphiques
- Barres de progression CSS par thème (score %)
- Utilise `radarData` existant de l'API

### Participant : niveau atteint
- Affichage `levelReached` par domaine de compétence dans les résultats
- Affichage `pointsEarned / maxPoints` si disponible

### Fix badge fantôme Admin Client
- Exclusion des notifications `TEST_COMPLETED` du compteur badge "Mes messages"

### CSS custom properties branding
- `--primary-color` et `--accent-color` appliqués globalement via BrandingContext
