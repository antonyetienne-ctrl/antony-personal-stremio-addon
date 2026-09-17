# Antony Personal Stremio Addon v5.4.0

## Fix ciblé
- Suppression du catalogue bootstrap générique basé sur `vote_count.desc`.
- Quand aucun dernier catalogue personnalisé complet n'est disponible, l'endpoint catalogue ne renvoie plus les mêmes 5–8 titres populaires pendant que le calcul travaille.
- Le calcul personnalisé continue en arrière-plan et n'écrit le catalogue qu'une fois le Top 30 complet.
- Conservation du dernier catalogue complet existant via Upstash/local cache.
- Le cache TMDB global existant est conservé.

## Important
Cette version ne réduit pas la profondeur du calcul personnalisé. Elle supprime uniquement le faux catalogue intermédiaire qui masquait le résultat réel.
