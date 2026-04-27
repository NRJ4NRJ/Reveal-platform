# CHANGELOG — ITERATION 9

Date : 2026-03-20

---

## 🔴 Corrections critiques

### 1. Import Excel — suppression des préfixes A) B) C) D)
**Fichier** : `backend/src/routes/super-admin/questions.ts`
- Ajout de `stripOptionPrefix()` : supprime les préfixes `A)`, `B)`, `A.`, `1)`, etc. en début de chaîne
- Appliqué à chaque option lors du parsing (colonne Options + distracteurs)
- Appliqué à la réponse correcte (`reponseCorrecteClean`) avant le calcul de `correctIndex`
- Résultat : les options sont stockées sans préfixe, la correspondance réponse correcte ↔ options est fiable

### 2. Import Excel — cohérence des réponses correctes
**Fichier** : `backend/src/routes/super-admin/questions.ts`
- `correctIndex` calculé sur des chaînes nettoyées (lower + trim + stripOptionPrefix) des deux côtés
- Pour TRUE_FALSE : la réponse correcte est nettoyée avant comparaison `vrai/faux`

### 3. Modifications manuelles reflétées côté salarié
**Diagnostic** : Le backend lit déjà les questions en direct depuis la DB à chaque appel à `GET /sessions/:id/next-question`. Les modifications manuelles sont donc immédiatement visibles pour les nouvelles sessions. Pour les sessions en cours, la question suivante est récupérée à chaque soumission, donc toute modification est reflétée dès la question suivante.

### 4. Renommage global « Compétence » → « Domaine de compétence »
**Fichiers** : tous les composants frontend + locales
- Remplacement de "Compétence(s)" par "Domaine(s) de compétence" dans tous les labels visibles
- Nouveaux clés i18n : `competencyDomain`, `skillArea`, `skillAreas`
- EN : "Skill area" / "Skill areas"

---

## 🟠 Améliorations importantes

### 5. Traduction Super Admin — audit exhaustif
**Fichiers** : `Questions.tsx`, `Tests.tsx`, `Messages.tsx`, `Dashboard.tsx`, `Responses.tsx`, `Settings.tsx`, `Clients.tsx`
- Remplacement de tous les textes codés en dur en français par des appels `t("clé")`
- Import de `useI18n` dans les fichiers qui ne l'avaient pas
- ~50 nouvelles clés i18n ajoutées aux deux fichiers de locale

### 6. Score ventilé par Domaine de compétence (sous-thème 2)
**Fichier** : `frontend/src/pages/participant/Tests.tsx`
- Affichage d'un tableau de scores par domaine de compétence dans la vue résultats
- Barre de progression + % + indicateur Réussi/Échoué par sous-thème 2
- Seuil de passage : 70%

### 7. Onglet « Réponses à analyser » — filtres enrichis
**Fichiers** : `frontend/src/pages/super-admin/Responses.tsx`, `backend/src/routes/super-admin/responses.ts`
- Filtres ajoutés : Grand thème, Sous-thème 1, Domaine de compétence (sous-thème 2), Salarié
- Nouveau endpoint backend : `GET /api/super-admin/responses/themes` (liste hiérarchique)
- Filtre par `subThemeId` et `subSubThemeId` dans le backend

### 8. Notifications après correction complète
**Fichier** : `backend/src/routes/super-admin/responses.ts`
- Après validation d'une réponse : vérification si toutes les réponses de la session sont corrigées
- Si oui → notification `ALL_RESPONSES_REVIEWED` envoyée au salarié

---

## 🟡 Nouvelles fonctionnalités

### 9. Repasser un test (participant)
**Fichiers** : `frontend/src/pages/participant/Tests.tsx`, `backend/src/routes/participant/index.ts`, `backend/prisma/schema.prisma`
- Bouton "Repasser le test" sur les tests avec statut COMPLETED
- Backend : création d'une nouvelle session avec `attemptNumber` incrémenté
- Schéma : ajout du champ `attemptNumber Int @default(1)` sur `TestSession`
- Affichage du numéro de tentative (Tentative 2, 3...) si > 1

### 10. Tableau de bord Super Admin — compteurs enrichis
**Fichiers** : `frontend/src/pages/super-admin/Dashboard.tsx`, `backend/src/routes/super-admin/stats.ts`
- 6 cartes de stats : Entreprises, Salariés, Tests assignés, En cours, Terminés, Réponses à analyser
- Filtre par entreprise cliente
- Carte "Réponses à analyser" cliquable → redirige vers `/super-admin/responses`
- Sous-compteurs Questions ouvertes / Scénarios cliquables avec tab pré-sélectionné

### 11. Paramètres Super Admin — changement d'e-mail
**Fichiers** : `frontend/src/pages/super-admin/Settings.tsx`, `backend/src/routes/super-admin/settings.ts`
- Nouveau formulaire : champ e-mail + confirmation par mot de passe
- Backend : `PUT /api/super-admin/platform-settings/email` avec validation format + unicité

### 12. Fiche entreprise détaillée (Super Admin)
**Fichier** : `frontend/src/pages/super-admin/Clients.tsx`
- Bouton "Voir la fiche" sur chaque entreprise
- Modal détaillée : toutes les données (adresse, SIRET, secteur, contact, couleurs, logo)
- Badge "Modifié par Admin Client" si `updatedByAdmin === true`

### 13. Tableau de bord Admin Client — i18n + placeholder ST2
**Fichier** : `frontend/src/pages/admin/Dashboard.tsx`
- Traduction complète en anglais
- Section placeholder "Score par Domaine de compétence" (backend à compléter)

### 14. Mes messages Admin Client — nettoyage
**Fichier** : `frontend/src/pages/admin/Messages.tsx`
- Traduction complète
- Confirmé : les notifications TEST_COMPLETED ne passent pas par le modèle Message → pas de mélange

---

## 🔧 Technique

### Nouvelles clés i18n (extrait)
`competencyDomain`, `skillArea`, `skillAreas`, `retakeTest`, `scoreBySkillArea`, `passed`, `failed`, `attempt`, `attemptN`, `activeEmployees`, `scoresByTheme`, `themeDetails`, `exporting`, `comingSoon`, `newCompany`, `viewProfile`, `clientProfile`, `siret`, `sector`, `contactName`, `phone`, `website`, `changeEmail`, `newEmail`, `clientCompanies`, `registeredEmployees`, `assignedTests`, `testsInProgress`, `testsCompleted`, `openResponsesToReview`, `scenariosToReview`, `openQuestionsCount`, `filterByClient`, `allClients`, `loadingError`, + ~30 autres

### Schéma DB
- `TestSession.attemptNumber Int @default(1)` — nécessite `docker compose --profile setup run --rm migrate`
