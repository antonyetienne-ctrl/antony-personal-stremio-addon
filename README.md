# 🎯 Recommandations personnelles pour Stremio — v7.0.0

Addon Stremio personnel : un catalogue **🎯 Recommandations selon vos Goûts** pour les films et un pour les séries,
exactement **30 titres** chacun, appris à partir de tes ❤️ (Love), 👍 (Like) et des contenus **vus sans appréciation** (signal négatif).
Node.js 22, **zéro dépendance**, Docker sur Render Free, Upstash Free, TMDB (fr-FR), Gemini facultatif.

## Installation (Render + GitHub)

1. Remplace le contenu du dépôt GitHub par ce ZIP (le déploiement automatique Docker se relance).
2. Variables d'environnement Render :
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` : déjà présentes, conservées telles quelles.
   - `CONFIG_SECRET` : **nouvelle**, texte aléatoire de 16 caractères minimum. Elle chiffre tes clés (sans elle, aucune clé n'est enregistrée).
   - `DIAG_TOKEN` : **nouvelle**, code d'accès à `/diagnostic`.
   - Options : `GEMINI_MODEL` (force un modèle), `GEMINI_MAX_CALLS_PER_DAY` (défaut 6), `IDLE_DELAY_MS` (défaut 20000).
3. Conseillé : vide la base Upstash une fois (Data Browser → Flush). Les anciennes clés v6 ne servent plus.
4. Ouvre `https://antony-personal-stremio-addon.onrender.com/configure`, renseigne le **TMDB Read Access Token**, l'**AuthKey Stremio**,
   (option) la **clé Gemini**, règle les filtres Films / Séries, enregistre.
5. Clique **Installer dans Stremio** (ou copie l'URL du manifest). L'URL ne contient **aucun secret** (identifiant aléatoire).
   La molette de Stremio ouvre ta page de configuration ; la désinstallation se fait dans Stremio comme pour tout addon.

## Premier calcul
Il démarre seul ~20 s après ta première ouverture d'un catalogue, ou tout de suite avec **Forcer un rebuild**.
Compte plusieurs minutes (jusqu'à 20-30 min sur Render Free, 0,1 CPU). **Garde la page de configuration ouverte** : elle interroge l'état
régulièrement, ce trafic entrant empêche Render de s'endormir pendant le calcul (aucun auto-ping sortant).
Tant qu'aucun Top 30 complet n'existe, les catalogues restent vides : jamais de liste partielle ni générique.

## Force Rebuild
Bouton de la page de configuration : contourne la limite quotidienne et l'égalité d'empreinte (calcul complet, Gemini inclus si son plafond du jour le permet).
Le backtest n'est refait que si l'historique ou la version ont changé.

## Synchronisation quotidienne
Au plus **une** synchronisation par **jour calendaire Europe/Zurich** (lundi 10 h : oui ; lundi 18 h : non ; mardi 00 h 01 : oui).
Au premier accès du jour, l'addon relit la bibliothèque et les statuts. Si l'empreinte (❤️/👍/vu/commencé) est identique, le résultat est réutilisé ;
sinon reconstruction complète. Un changement de **filtres** recalcule aussitôt les seuls types concernés (bibliothèque et profil réutilisés).
Une nouvelle **version du moteur** déclenche un nouveau calcul même si la synchro du jour a eu lieu ; l'ancien Top 30 reste servi jusqu'à la publication du nouveau.

## Diagnostic
`https://…onrender.com/diagnostic?token=TON_DIAG_TOKEN` (JSON) : état et étape du job, dernier calcul avec chronométrage par étape,
checkpoint, empreintes, version, compteurs Upstash (par commande et par étape), appels TMDB/Gemini, backtest (Precision@10/30, taux de ❤️/👍,
faux positifs, calibration, variantes comparées), profil appris, Top 30 avec scores, erreurs récentes. Aucune clé n'y figure.

## Choix qui s'écartent de la consigne (et pourquoi)
- **Gemini** : `gemini-1.5-flash` est arrêté par Google (erreur 404). Le modèle est donc choisi dynamiquement (`models.list`, Flash-Lite récent d'abord).
  Appels en **REST via `fetch`, sans SDK** : zéro dépendance, rien à installer sur Render. Budget : 1 requête « ADN + anti-recettes » (en cache tant que
  l'historique est inchangé) + 1 requête « arbitrage » (Films et Séries ensemble) par synchro, avec plafond quotidien dur. Son influence est **bornée** :
  il départage la frontière sans pouvoir hisser un titre que le modèle local juge mauvais. Pas d'embeddings Gemini (des dizaines de requêtes, incompatibles avec ta limite de 1-2).
  Son apport ne peut pas être mesuré par backtest avec ce budget.
- **RAM-first, avec une exception** : découverte et scoring 100 % en RAM ; Upstash reçoit 1 payload de résultats, l'état du job, un snapshot et le **cache TMDB par blocs**
  (mesuré en test : 93 commandes pour un calcul complet). Sans ce cache, chaque redémarrage de Render Free obligerait à retélécharger des milliers de fiches.
- **Rejet « vu sans note »** : aucun mot-clé banni isolément ; un négatif pèse selon la note TMDB du titre ; seules des **combinaisons** à support minimum sont apprises,
  et Gemini (ou une règle locale sur les titres bien notés) sépare combinaison toxique et coïncidence.
- **Séries** : TMDB n'a pas de genre Horreur/Romance/Musique pour les séries, détection par mots-clés (genres « virtuels » dans les réglages).

## Limites connues (à vérifier après déploiement via /diagnostic)
- Le format des réponses de `likes.stremio.com` n'est pas documenté : lecture tolérante ; la synchro est abandonnée (ancien Top 30 conservé) si trop de statuts sont inconnus ou si les ❤️/👍 chutent brutalement.
- Sémantique « vu / commencé » des séries : heuristique prudente (une série seulement commencée est exclue mais n'est pas un négatif).
- Les titres notés ❤️/👍 mais absents de ta bibliothèque Stremio ne sont pas visibles sans les addons officiels « Stremio Liked/Loved ».
- Reprise après redémarrage : le calcul repart de la bibliothèque avec le cache TMDB chaud (checkpoint = étape + cache), pas au milieu d'une étape.
- **Non testé en réel** : TMDB, Stremio, Upstash et Gemini n'étaient pas joignables depuis mon environnement ; tout est validé sur simulation (`test/`).
- Pas de graphe de connaissances ni de pénalité de saturation : aucun gain démontrable avec les données disponibles.

## Tests
`npm test` (14 scénarios, ~80 s) : règle quotidienne Zurich, atomicité sous pannes TMDB/Likes/Upstash/Gemini, statuts illisibles jamais négatifs, changement de filtres,
Top 30 sans quota et aléatoire après sélection, reprise, changement de version, conservation des clés, routes HTTP, Gemini ≤ 2 requêtes, Love ≠ Like et 70/30, filtres, fr-FR, calcul complet 30+30.

## Nouveautés 7.1.0
- **Genres** : une case à cocher par genre (films et séries), **aucune cochée par défaut**, aucune pénalité codée en dur. Case **Kids / Enfants** distincte d'Animation et de Familial.
- **Animation** : case « Exclure toute l'animation sauf japonaise » (cochée pour les séries, décochée pour les films).
- **Note et votes minimum** : mode **automatique** par défaut = 10e percentile de tes ❤️/👍 (planchers : note 5, votes 100). Mode manuel disponible.
- **Vu sans note** = négatif complet (inverse d'un 👍). La note et les votes TMDB sont des critères que le modèle apprend.
- **Classement orienté ❤️** : P(❤️) = mélange de la décomposition P(apprécié)·P(❤️|apprécié) et d'un modèle ❤️ direct ; α et β choisis par le backtest (taux de ❤️ dans le Top 30).
- **Backtest** sans découpage temporel (les notes ont été saisies à la main) : tirage déterministe 80/20.
- **Diagnostic** : répartition note/votes/année de tes ❤️/👍 et seuils retenus (`taste`), liste « vus sans note probablement aimés » (`recheck`), suivi de la précision réelle du Top 30 précédent (`precision` : ❤️, 👍, vu sans note, non vu).
- **Année minimale** (films : 1990 par défaut, séries : aucune) et **durée minimale** films (70 min).

## 7.1.1
- Arbitrage Gemini : lecture tolérante de la réponse (tableau direct, clés variantes, scores en fraction) et conservation d'un extrait de la dernière réponse dans le diagnostic (`arbitrage.trace`, `arbitrage.responseShape`).
- Le classement final n'affiche plus de calibration/logloss (ce n'est pas une probabilité).

## 7.1.2
- Liste « à revérifier » : 20 films + 20 séries, avec `why` (T = fois vu, F = marqué vu, R = part regardée, D = durée) pour comprendre pourquoi Stremio compte un titre comme vu.

## 7.1.3
- `/diagnostic/<n'importe quoi>` (ex. `/diag/2?token=…`) : même page, chemin distinct pour contourner un cache éventuel.
- Diagnostic : `counts.stateMatrix` (répartition des signaux Stremio vu / commencé, films et séries) et `counts.seriesSamples`.

## 7.2.0
- **Qualité sur IMDb** : note et votes minimum jugés sur le jeu de données public IMDb (`title.ratings`), seuils automatiques déduits de tes ❤️/👍 (échelle IMDb). Le pré-filtre TMDB est élargi ; le filtre réel est IMDb.
- La note/les votes IMDb sont aussi des critères appris par le modèle.
- **Repli** : copie persistée (Upstash) si le téléchargement échoue ; sans copie ni couverture suffisante, retour aux notes TMDB (indiqué dans `job.imdb` du diagnostic).
- Une œuvre présente dans la bibliothèque mais NON vue et NON notée reste recommandable (test de non-régression).

## 7.2.1
- **Séries** : une série est « vue » seulement si elle est marquée vue au niveau série (drapeau F) ou marquée à la main sans lecture ; des épisodes lus => « commencée » (exclue des recommandations, pas un rejet). Stremio incrémente timesWatched à chaque épisode joué.
- **Titres à surveiller** (page de configuration) : le diagnostic (`report.watch`) dit pour chaque titre s'il est trouvé, vu/noté/commencé, filtré (règle), énuméré, et son rang.

## 7.2.2
- Diagnostic `report.favorites` : pour les films et les séries, le Top 30 des titres de TON historique (vus compris) classés par probabilité de coup de cœur, estimée HORS ÉCHANTILLON, avec ton vrai statut (❤️/👍/vu sans note), la répartition dans le Top 10/30 et le rang médian de tes ❤️.

## 7.2.3
- **Exclusion** : seul un titre marqué VU est exclu (commencé ou noté sans être marqué vu : recommandable).
- **Détection VF** (séries, mode information) via l'API Streaming Availability (clé RapidAPI dans /configure) : statut VF / VOSTFR / VO seule dans `report.vf` du diagnostic, cache Upstash (VF conservé pour toujours, autres revérifiés chaque semaine, « inconnu » si API muette > 6 mois et série récente), pastille d'état et bouton de test dans /configure, case pour activer/désactiver. Séries FR/US non concernées, animes exemptés. N'exclut rien.
- Suppression de la surveillance de titres.

## 7.2.4
- Page de configuration : correction d'une erreur JavaScript (apostrophe) qui bloquait le statut et les boutons ; la pastille de l'API VF s'affiche (route /status).
- **Films** : le drapeau `flaggedWatched` seul n'est plus un « vu » (résidu d'un marquage retiré) ; vu = compteur > 0 ou ≥ 70 % d'un vrai film (≥ 30 min).
- **Séries** : vue = drapeau série, ou compteur > 0 sans suivi d'épisodes (marque manuelle) ; épisodes lus = commencée.
- **VF** : les clés `motn-key-…` (developers.movieofthenight.com) utilisent l'API directe `api.movieofthenight.com/v4` (en-tête X-API-Key) ; message d'erreur de l'API conservé (`sante.lastBody`) ; exemption limitée à l'animation japonaise.
- Diagnostic : `report.bibliotheque` = signaux Stremio bruts des titres du Top 30 déjà en bibliothèque.

## 7.2.5
- **Séries** : le drapeau `flaggedWatched` seul (compteur à 0) n'est plus un « vu » (résidu d'un marquage retiré : True Beauty, Crash Landing on You, Snowdrop). Vue = compteur > 0 ET (drapeau série OU pas de suivi d'épisodes). Épisodes lus sans drapeau, ou drapeau seul = commencée.

## 7.2.6
- **Séries vues** : compteur > 0 avec suivi d'épisodes mais AUCUNE progression de lecture = série entière marquée vue à la main (Silo, Le Jeu de la dame, Alice in Borderland, Game of Thrones).
- **Exclusion VF** (séries) : écartée si statut VOSTFR / VO seule / absente des plateformes FR ET langue d'origine asiatique ou turque ; jamais pour les séries FR/US ni l'animation japonaise ; « inconnu » (panne, jamais vérifié) = gardée. Appliquée avant Gemini et la sélection finale ; liste des exclusions dans `report.vf.exclusions`. La case « Détection VF » la désactive (comportement d'avant).

## 7.2.6 (mesure Gemini)
- **Mesure de l'apport de Gemini** (`backtest.geminiEval` du diagnostic) : ADN régénéré sur les titres d'apprentissage seulement, Gemini note des titres de test sans voir le score local ; comparaison local / Gemini seul / mélanges (0 à 100 %) avec intervalles de confiance et verdict (poids conseillé). Coût : 3 requêtes une fois par changement d'historique. RIEN n'est modifié dans le classement de production (poids actuel de Gemini : 35 % de la fenêtre d'arbitrage).

## 7.2.7
- **ADN par sous-genres et mots-clés** : tableau de PREUVES calculé sur l'historique (combinaisons de 1 à 3 genres, mots-clés, couples genre + mot-clé ; décomptes ❤️ / 👍 / ✗, appréciation, fiabilité « suffisante » à partir de 8 titres, « faible » de 5 à 7, rien en dessous) transmis à Gemini avec un échantillon réparti par genre. Plus aucun « trait appris » négatif, plus aucun goût écrit en dur : les seuls « rejets » connus de Gemini sont les FILTRES ACTIFS de la page de configuration (`src/evidence.js`).
- **Prompts** validés (ADN : `adn / moteurs_d_adhesion / facteurs_repulsifs / nuances / recettes_toxiques` ; arbitrage : `adequation / risque / connaissance / incompatibilite / motif`), sans `score_local`.
- **Fenêtre de 80 candidats** par type, une requête Gemini par type (2 par calcul), réserve de 100 candidats.
- **Malus progressif** (pas d'interrupteur) : gravité = adéquation sous `fit0` et/ou risque au-dessus de `risk0`, +0,35 si incompatibilité majeure, réduite de moitié au plus si Gemini connaît mal le titre ; malus = `alpha × gravité`. Garde-fous : 40 % de la fenêtre au plus subit le malus complet, remplaçants pris dans la réserve, Top toujours complet, classement local pur sans avis Gemini.
- **Calibration automatique par le backtest** (`backtest.geminiEval.malus`) : mesure au protocole de production (ADN régénéré sur l'apprentissage seulement, titres de test notés par Gemini), grille `fit0 ∈ 25-45`, `risk0 ∈ 55-75`, `alpha ∈ 0,5-1`, objectif = part de ❤️ du haut de liste après remplacement, plancher de sévérité (25 / 75 / 0,5), petits pas d'un calcul à l'autre, réglage précédent conservé sans gain net, repli sur le plancher si Gemini n'aide pas.
- **Diagnostic** : `report.arbitrage` (réglages du malus, entrants / sortants / pénalisés par type), `report.surprises` (❤️/👍 jugés improbables, « vus sans note » jugés probables), `backtest.geminiEval` (mesure et calibration).
- **Upstash** : relecture du cache TMDB et du cache VF en vol unique, pause après un échec, échec partiel = échec, aucune écriture si la relecture a échoué.
- Plafond Gemini par défaut : 100 requêtes par jour (`GEMINI_MAX_CALLS_PER_DAY`).

## 7.2.8
- **Séries : règle définitive** — une série est VUE dès qu'au moins un épisode est terminé ou marqué vu (compteur `timesWatched` > 0), que ce soit Stremio ou l'utilisateur à la main ; la note, aimé ou non, l'état des épisodes n'y changent rien ; tout ce qui est vu est exclu (cas Outlander : 22 épisodes vus). Le drapeau seul (compteur 0) reste un résidu, un début de lecture sans épisode terminé reste « commencé ».
- **Mesure Gemini** : seuls les titres de test qui respectent les filtres ACTUELS sont notés et comptés (avant, un ❤️ de l'historique violant un filtre — dessin animé, téléréalité — était sanctionné par Gemini pour une raison qui n'existe pas en production, ce qui faussait la calibration du malus vers le plancher).

## 7.2.9 — arbitrage Gemini par PROXIMITÉ (variante C)
- **Plus de résumé d'ADN rédigé** (source de caricatures : « rejette massivement le fantastique »), **plus de filtres dans les prompts**, plus aucun goût écrit en dur. Pour chaque candidat, Gemini reçoit ses caractéristiques (titre, année, genres, mots-clés, synopsis) et ses **3 titres ADORÉS (❤️) et ses 3 titres NON AIMÉS (✗) les plus proches** dans l'historique (similarité des vecteurs hachés) ; il répond `proche_des_adores`, `proche_des_non_aimes`, `connaissance`, `motif`, sans jamais juger la qualité ni la réputation.
- Note utilisée : `fit = (100 + proche_des_adorés − proche_des_non_aimés) / 2` (50 = neutre). Un titre que Gemini connaît mal voit son avis ramené vers la médiane (au plus 60 % de l'écart effacé) : un titre récent ou inconnu (ex. L'Odyssée) n'est plus pénalisé par le seul synopsis, ni dans le mélange, ni dans le malus.
- Fenêtre de 80 candidats par type, en 2 lots de 40 (4 requêtes par calcul).
- **Calibration automatique** (`backtest.geminiEval.malus`) du malus (`fit0`, `alpha`) ET du poids de Gemini (`wg` ∈ 0,1 / 0,2 / 0,35) par simulation de la vraie sélection sur les titres de test (voisins pris dans l'apprentissage seulement, titres respectant les filtres actuels) ; plancher de sévérité, petits pas, repli sur le plancher si Gemini n'améliore pas le haut de liste.
- L'ancien code d'ADN (`dnaPrompt`, `arbitragePrompt`, `stratifiedSample`, `src/evidence.js`) n'est plus appelé : à retirer lors de l'audit du code.

## 7.3.0 — catalogues de bibliothèque et outil de vérification
- **📌 Votre liste de lecture** : deux catalogues (Films, Séries) qui affichent TOUTE la bibliothèque Stremio de l'utilisateur, vus et non vus mêlés, séparée par type. Lecture à la demande (mémoire de 10 min, liste périmée servie aussitôt puis rafraîchie en arrière-plan, dernière liste connue si Stremio est en panne), mêmes exclusions que la bibliothèque de Stremio (ni retirés, ni temporaires), tri par activité récente, pages de 100 (`skip`). Deux cases dans la page de configuration (activées par défaut) ; ces réglages ne relancent aucun calcul. Après modification, réinstaller l'addon dans Stremio (le manifest change).
- **`/diag/check?token=…&q=tt0111161,Outlander,Off Campus`** : vérifie une liste de titres (identifiants IMDb ou noms, 30 maximum) : dans la bibliothèque ? décision vu / commencé et signaux bruts (compteur, drapeau, progression, liste d'épisodes) ; ❤️/👍 ; passe-t-il les filtres actuels (sinon lequel bloque) ; rang dans le Top 30 publié ; rang local parmi les 400 premiers candidats du dernier calcul (`job.ranks`). Lecture seule, protégé par DIAG_TOKEN.
- Libellé de l'option Gemini corrigé (comparaison à l'historique, plus d'ADN rédigé).

## 7.4.0 — embeddings sémantiques (version B), filtre Sitcom, « Continuer à regarder » retiré des 📌
- **Embeddings (Gemini, `src/embed.js`)** : chaque titre est représenté par un vecteur de 256 nombres (modèle `gemini-embedding-001`, repli `gemini-embedding-2`) calculé sur « type, titre, année, genres, synopsis, mots-clés ». Vecteurs quantifiés sur 8 bits, cachés dans Upstash (12 blocs par modèle), lus une seule fois par processus, jamais écrasés si la lecture a échoué.
- **Cadence et quota** : lots de 100 textes, intervalle minimal 4,5 s (`EMBED_MIN_INTERVAL_MS`), plafond `EMBED_MAX_CALLS_PER_DAY` (300 requêtes), budget de temps par calcul (`EMBED_BUDGET_MS`, 4 min pour l'historique ; `EMBED_CAND_BUDGET_MS`, 90 s pour les candidats). Sur une réponse 429 : lots divisés par deux, attente exponentielle (65 s puis ×2), pause de 30 min après 4 échecs ; refus 400/401/403/404 : pause d'une heure. La vectorisation s'étale sur plusieurs calculs si nécessaire ; sans embeddings le comportement est exactement celui de la 7.3.0.
- **Rien n'est adopté sans mesure** : (1) *voisins* : comparaison « un contre tous » sur tout l'historique (validation par élimination d'un titre à la fois) entre voisins sémantiques et voisins « genres + mots-clés » ; adoption si la couverture ≥ 90 % et AUC ❤️ sémantique ≥ AUC hachée − 0,005 ; les voisins choisis servent à la mesure Gemini ET à l'arbitrage de production ; la méthode fait partie de la clé de mise en cache du backtest. (2) *score par voisins mélangé au classement local* : poids 0 / 0,1 / 0,2 / 0,3 / 0,4 choisi sur les titres de test (voisins pris dans l'apprentissage), adopté seulement si le gain d'AUC ❤️ ≥ 0,01 et si l'intervalle bootstrap à 95 % du gain ne descend pas sous −0,01 ; appliqué aux 250 meilleurs candidats de chaque type, seulement si 90 % d'entre eux ont un vecteur.
- **Diagnostic** : `users[].embeddings` (modèle, couverture, requêtes du jour, comparaison des voisins, table des poids, verdicts, dernier arrêt) ; `report.arbitrage.voisins` ; `backtest.geminiEval.voisins`.
- **Filtre Sitcom** (séries) : genre virtuel `v:sitcom` détecté par mots-clés TMDB (sitcom, situation comedy, multi-camera, laugh track, live studio audience…), case dans les genres à exclure.
- **📌 Votre liste de lecture** : les titres déjà présents dans « Continuer à regarder » de Stremio (point de reprise `timeOffset` > 0) n'y figurent plus.
- **`/diag/check`** : correspondance de noms stricte (identique, puis mot entier, puis recherche TMDB, en dernier recours sous-chaîne), mots-clés et genres virtuels affichés, statut VF (cache) et rang avant / après exclusion VF pour les séries, état de vectorisation ; la liste peut passer dans le chemin : `/diag/check/Outlander,tt0111161?token=…`.

## 7.4.1 — vectorisation régulée en titres par minute, progression sauvegardée, reprise en arrière-plan
- **Le quota gratuit de Google compte chaque TITRE d'un lot** (constaté sur le diagnostic 15 : 429 en cascade avec des lots de 100). Régulation en **titres par minute** : débit de départ `EMBED_TEXTS_PER_MIN` (70), maximum `EMBED_MAX_TEXTS_PER_MIN` (100), minimum 15 ; lot = 30 secondes de débit (≈ 35 titres) ; pause après un lot = taille / débit ; après un refus « quota » le débit baisse de 40 % (attente courte 20 s puis ×2 jusqu'à 2 min) ; après 4 lots réussis il remonte de 10 % ; le débit appris est conservé d'un calcul à l'autre (`job.embed.rate`). Un 429 qui mentionne le quota JOURNALIER arrête la vectorisation jusqu'à minuit (Zurich) ; 5 refus d'affilée = pause de 30 min.
- **Plafonds quotidiens** : `EMBED_MAX_TEXTS_PER_DAY` (1 400 titres) en plus de `EMBED_MAX_CALLS_PER_DAY` (300 requêtes) ; compteurs remis à zéro chaque jour (Zurich). L'historique est vectorisé avant les candidats.
- **Progression sauvegardée régulièrement** (`EMBED_FLUSH_EVERY_MS`, 60 s) et à chaque arrêt : une coupure du serveur ne fait plus perdre la vectorisation en cours.
- **Reprise en arrière-plan sans relancer le calcul** : la liste des titres restants (`job.embed.todo`, identifiants TMDB) est conservée ; `embedContinue` relit leurs fiches dans le cache TMDB et vectorise par passes de `EMBED_CONT_BUDGET_MS` (4 min), toutes les 30 s (`EMBED_CONT_DELAY_MS`), jusqu'à épuisement ou plafond du jour (reprise à minuit). Elle est programmée à la fin de chaque calcul et au démarrage (2 min). Quand l'historique est vectorisé à 90 %, elle lance UN recalcul léger (`rerank`, motif « vectorisation des embeddings terminée ») qui mesure les voisins sémantiques et le poids, et qui les applique s'ils sont meilleurs (`appliedFull`). Trois passes sans progrès : arrêt jusqu'au prochain calcul. `EMBED_BACKGROUND=off` désactive la reprise (tests).
- **Diagnostic** : `embeddings.debitTitresParMinute`, `restant` (historique / candidats), `reprise` (passes, passes sans progrès, prise en compte).

## 7.5.0 — fiches « pourquoi », vectorisation de tous les candidats, quotas de Google, ordre des catalogues, vitesse
- **Fiches « pourquoi »** (`src/why.js`) : un texte ajouté EN TÊTE de la fiche Stremio (`/meta`) des titres du Top 30 et des titres NON VUS de la liste de lecture 📌 quand le modèle est concluant (liste de lecture : niveau « incertain » = aucun texte). Rien n'est retiré de la fiche (note IMDb, synopsis, épisodes, affiche). Niveaux (probabilité de coup de cœur, seuils calés sous 0,5 / 0,7 car le modèle est un peu trop confiant) : très probable ≥ 0,66, probable ≥ 0,56, bonnes chances ≥ 0,46, incertain ≥ 0,30, peu de chances ; 5 points ●●●●○. Contenu : titres adorés dont il est proche (voisins sémantiques si disponibles, sinon « genres + mots-clés » ; jamais cité sous un seuil de similarité), ✅ ce qui devrait plaire (genres et mots-clés à poids positif, mots-clés traduits en français, jamais d'anglais), ⚠️ à surveiller (titre non aimé très proche, sinon traits à poids négatif). Gabarits, aucune requête Gemini. Stockage : un document Upstash par utilisateur (`av7:why:<id>`, RAM d'abord). `job.whyStats` / diagnostic `fiches`.
- **Tous les candidats admissibles sont vectorisés** (dans l'ordre du classement local, la reprise en arrière-plan finit le travail). Le mélange par voisins sémantiques est appliqué quand 90 % des 400 mieux classés ont un vecteur ; les candidats sans vecteur reçoivent une valeur neutre (moyenne de l'historique), donc aucune avance artificielle.
- **Quotas de Google** : journée de quota = journée du Pacifique (remise à zéro à minuit heure du Pacifique, ≈ 9 h à Zurich) ; plafond `EMBED_MAX_TEXTS_PER_DAY` 900 (le quota gratuit observé est d'environ 1 000 titres par jour) ; reprise à la remise à zéro + 3 min (`nextPacificMidnight`) ; un 429 qui mentionne le quota journalier, ou 3 refus d'affilée alors que le débit est déjà au minimum, arrête la vectorisation jusqu'à la remise à zéro ; le corps des erreurs HTTP conservé est porté à 1 200 caractères ; remontée du débit +25 % après 3 lots réussis. Défaut corrigé : les statistiques, la dernière erreur, la pause et la taille de lot n'étaient plus enregistrées à la fin de l'étape « embeddings » (ligne neutralisée par un commentaire).
- **Ordre des catalogues** : quatre listes déroulantes dans les réglages (`catalogOrder`), ordre du manifest ; doublons ignorés, catalogues manquants ajoutés, désactivés absents, aucun recalcul (réinstaller l'addon dans Stremio après modification).
- **Vitesse** : (1) mémoire des similarités par candidat dans le scoring (`item._sim`) : les tâches et profils partagent les mêmes vecteurs d'entraînement, 3 à 5 fois moins de produits scalaires, scores strictement identiques ; (2) « Forcer un rebuild » ne refait plus le backtest (≈ 3 min) quand l'historique, la version et la méthode de voisins sont identiques ; (3) budgets de vectorisation pendant un calcul ramenés à 90 s (historique) et 45 s (candidats) : la reprise en arrière-plan fait le reste.

## 7.6.0 — installations multiples, 🔔 Nouvelles Saisons (la 7.5.0 est incluse : elle n'a pas été déployée seule)
- **Installations multiples** : `settings.common.install = { count: 1|2, assign: { <catalogue>: 1|2 } }`. Une seule page de réglages, mêmes résultats ; seule la liste des catalogues d'un manifest change. `/u/<id>/manifest.json` = installation 1 ; `/u/<id>/manifest2.json` = installation 2 (404 tant que « 2 installations » n'est pas choisi ; id `com.antony.personalrecommendations.2`). Nom déduit du contenu (« — Films », « — Séries », sinon « (n) »), ressources `meta` limitées aux types de l'installation. Les routes de catalogue sont communes. Chaque changement de répartition demande de réinstaller dans Stremio ; avec deux installations, désinstaller l'installation unique. Aucun recalcul (hors empreinte).
- **🔔 Nouvelles Saisons Disponibles** (`antony_new_seasons`, séries, `src/seasons.js`) : séries marquées VUES (règle « vu » du moteur) ET notées 👍/❤️ dont une saison est sortie il y a moins de 90 jours (date du premier épisode de la saison, TMDB `/tv/{id}` `seasons[].air_date`, mémoire 6 h) ; disparaît quand la saison a plus de 90 jours OU quand tous ses épisodes (sortis ou annoncés : max entre TMDB, Cinemeta et le nombre annoncé) sont marqués vus ; les saisons précédentes ne comptent pas. Lecture des épisodes vus : `state.watched` = « épisodeAncre:longueur:bits (base64, zlib) », aligné sur la liste d'épisodes Cinemeta (sinon reconstruite depuis TMDB, avec ou sans spéciaux) ; décodage CONTRÔLÉ (dernier bit à 1 = épisode d'ancre, ordre des bits testé dans les deux sens, décalage recalé sur l'ancre) ; doute (liste illisible ou incohérente) => la série reste affichée jusqu'à la limite des 90 jours, jamais cachée à tort. Étiquettes 👍/❤️ prises dans le dernier instantané (mises à jour à chaque calcul). Case dans la page de configuration (activée par défaut), ordre des catalogues à 5 entrées.
- **/diag/check** : la liste brute des épisodes vus (`etatBrut.watched`), son décodage (`decodageListeVue` : épisode d'ancre, longueur, octets, bits à 1 dans chaque ordre) et, pour les séries, `nouvellesSaisons` (éligible, saison récente, jours écoulés, état, source de liste, affichée ?).

## 7.7.0 — fiches descriptives de contenu (MESURE SEULEMENT) ; inclut 7.5.0 et 7.6.0
- **Fiches descriptives** (`src/cards.js`) : Gemini décrit chaque titre de l'historique UNE FOIS avec 17 critères notés de 0 à 10 (ton sombre, humour, émotion, suspense, romance, action, violence, rythme, complexité, réalisme, ampleur épique, univers imaginaire, contexte historique, inspiré de faits réels, public visé, introspection, feuilleton) + une note de confiance ; jamais de jugement de qualité. Lots de 25 titres, cadencés (`CARDS_MIN_INTERVAL_MS` 5 s), sauvegardés (document Upstash partagé `av7:cards:c1`, 18 caractères par titre), une réserve de 40 requêtes/jour (`CARDS_RESERVE_CALLS`) reste pour le calcul ; génération en arrière-plan par passes de 3 minutes (`CARDS_CONT_BUDGET_MS`), planifiée à la fin de chaque calcul, reprise après pause (429, plafond du jour). `CARDS_BACKGROUND=off` la désactive.
- **Mesure** : quand 90 % de l'historique a une fiche, UN recalcul léger (`rerank`) entraîne le modèle AVEC les critères (caractéristiques `x:<critère>` continues + 3 tranches, pondérées par la confiance, seulement quand `rec.cd` existe) et le compare au modèle de production sur les MÊMES titres de test (même variante, mélange 70/30, classement final), avec intervalle de confiance à 95 % par tirages appariés, taux de ❤️ du top 20 et les critères les plus liés à ses goûts. `job.cards.eval` / diagnostic `fichesDescriptives` : coverage, restant, stats, eval { sans, avec, gain, ic95GainCoupDeCoeur, verdict, criteresLesPlusLies, appliqueAuClassement: false }. Les critères sont exclus des vecteurs de similarité ; aucune fiche n'est greffée sur les données de production ; le classement n'est pas modifié.
- La clé du backtest distingue « fiches complètes » : la mesure se fait une fois, puis est réutilisée tant que rien ne change.

## 7.8.0 — Top 30 « sûr », échelle stricte, validation croisée, découverte complète, installation 2 corrigée (inclut 7.5.0 à 7.7.0)
- **Objectif** : un Top 30 de titres que l'utilisateur va AIMER, sans pari, avec le moins possible de pouces en bas ; toujours 30 titres.
- **Échelle stricte ❤️ +3 / 👍 +1 / vu sans note −1** (`model.SCALE`, `expectedScale` : E = 2·(P(❤️) + P(apprécié)) − 1). Classement = valeur attendue sur l'échelle. Apprentissage : un ❤️ pèse 3 dans le modèle « apprécié » (`loveWeight`), un 👍 et un vu sans note pèsent 1 (inverses l'un de l'autre) ; le sous-modèle ❤️ direct est entraîné sur ❤️ contre vus sans note, les 👍 en sont EXCLUS (un 👍 n'est plus jamais un échec) puis P(❤️) est ramenée aux trois issues par la décomposition. Gemini compare aussi chaque candidat à 2 titres 👍 ; côté positif = (3·adorés + 1·appréciés) / 4.
- **Validation croisée** (`src/cv.js`) : tout l'historique (4 parties, chaque titre noté par un modèle qui ne l'a jamais vu). Réglages de SÉCURITÉ par type (part du ❤️ direct, pénalités d'incertitude, seuil de risque τ au-delà duquel un titre est fortement rétrogradé, `SAFETY_LAMBDA`), choisis pour maximiser la valeur moyenne des premiers titres avec un pouce en bas très pénalisé (❤️ +3, 👍 +1, vu sans note −4) ; le défaut n'est abandonné que pour un gain net. Courbe de sécurité et calibration du risque, résultats mis en cache (`job.cv`, recalcul si l'historique change de plus de 40 titres).
- **Pertes par étage** (diagnostic) : filtres, classement local hors des premiers 5/10/25 %, et ce que rattraperait un **repêchage sémantique par rang** (`common.rescueSemantic`, DÉSACTIVÉ par défaut, mesure seulement tant qu'il n'est pas coché).
- **Découverte complète** : limite portée à 250 pages par tri (TMDB : 500) ; l'univers admissible (films ≈ 4 200) est énuméré en un seul tri (≈ 210 appels au lieu de 300) et `universeComplete` n'est vrai que si toutes les pages ont été lues.
- **Affichages « pourquoi »** (réglages `whyMeta`, `whyCards`, `whyStream`, tous activés par défaut) : texte en tête de la fiche ; points de chances ●●●●○ dans le sous-titre des cartes des catalogues ; ligne d'information en tête de la liste des flux (ressource `stream`). Le niveau est calculé sur la valeur attendue de l'échelle (chances de coup de cœur ET risque de déception).
- **Page « recheck »** `/u/<id>/recheck` : tous les vus sans note triés par probabilité d'avoir été aimés, avec liens pour les ouvrir dans Stremio.
- **🔔 Nouvelles Saisons** : fenêtre de 12 mois (365 jours).
- **Upstash** : 3 essais (attente croissante) pour les écritures (SET/DEL/SADD, sans danger à rejouer), 2 pour les lectures.
- **Installation 2 corrigée** : le lien est maintenant `/u/<id>/2/manifest.json` (il se termine par `/manifest.json` comme le veut Stremio ; l'ancien `manifest2.json` reste accepté) ; catalogues, fiches, flux et page de réglages sont servis sous `/u/<id>/2/…` par les mêmes routes ; texte d'aide sur la page (désinstaller l'ancienne installation unique, réinstaller après chaque changement de répartition, « Addons → Ajouter un addon » en secours).
- **Nettoyage** : fiches descriptives (`cards.js`), `evidence.js`, ancien ADN / ancien prompt d'arbitrage / échantillonnage, ancien poids des négatifs, variantes A et B du backtest retirés. Fichiers à supprimer du dépôt : `src/cards.js`, `src/evidence.js`.
