'use strict';
const { MOVIE_GENRES, TV_GENRES, ENGINE_VERSION } = require('./config');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:780px;margin:22px auto;padding:0 16px;line-height:1.45}h1{font-size:1.35em}h2{font-size:1.1em;margin:0 0 6px}
section{background:#1b1b1b;padding:16px;border-radius:14px;margin:14px 0}label{display:block;margin:10px 0 4px;font-size:.93em}textarea,input[type=text],input[type=password],input[type=number],select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#242424;color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.chk{display:flex;align-items:center;gap:8px;margin:6px 0}.chk input{width:auto}.genres{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px}
.btn{display:block;width:100%;padding:13px;border:0;border-radius:9px;font-weight:700;background:#fff;color:#111;margin-top:12px;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}.btn.sec{background:#333;color:#fff}
.muted{opacity:.7;font-size:.86em}.ok{background:#172b1d;padding:10px;border-radius:10px}.warn{background:#3a2a12;padding:10px;border-radius:10px}.err{background:#3a1616;padding:10px;border-radius:10px}code{background:#000;padding:2px 5px;border-radius:5px;word-break:break-all}
progress{width:100%}`;

const genreBoxes = (prefix, list, selected) => `<div class="genres">${list.map(([id, name]) => `<label class="chk"><input type="checkbox" name="${prefix}.exclude" value="${esc(id)}" ${selected.map(String).includes(String(id)) ? 'checked' : ''}>${esc(name)}</label>`).join('')}</div><input type="hidden" name="${prefix}.exclude__present" value="1">`;
const keyField = (name, label, view, required, hint) => `<label>${label}${required ? ' *' : ''}</label><input type="password" name="${name}" autocomplete="off" placeholder="${view && view.has[name] ? `enregistrée (${esc(view.keys[name])}) — laisser vide pour la conserver` : (required ? 'à renseigner' : 'facultatif')}"><div class="muted">${hint || ''}</div>`;

function page({ mode, view, status, host, notice, secretsReady = true }) {
  const s = view ? view.settings : require('./config').defaultSettings();
  const edit = mode === 'edit';
  const action = edit ? `/u/${esc(view.id)}/config` : '/configure';
  const manifestUrl = edit ? `${host}/u/${view.id}/manifest.json` : '';
  const stremioUrl = manifestUrl ? `stremio://${manifestUrl.replace(/^https?:\/\//, '')}` : '';
  const opt = (v, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${v === 'score' ? 'Ordre de pertinence (meilleure → moins bonne)' : 'Ordre aléatoire (Top 30 mélangé, composition inchangée)'}</option>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🎯 Recommandations selon vos Goûts</title><style>${CSS}</style></head><body>
<h1>🎯 Recommandations selon vos Goûts <span class="muted">v${ENGINE_VERSION}</span></h1>
${notice ? `<div class="${notice.kind || 'ok'}">${esc(notice.text)}</div>` : ''}
${!secretsReady ? `<div class="err">La variable <code>CONFIG_SECRET</code> (16 caractères minimum) n'est pas définie sur Render : aucune clé ne peut être enregistrée tant qu'elle manque.</div>` : ''}
${edit ? `<section><h2>Installation dans Stremio</h2><a class="btn" href="${esc(stremioUrl)}">Installer / mettre à jour dans Stremio</a><div class="muted" style="margin-top:8px">Lien du manifest (ne contient aucune clé) : <code>${esc(manifestUrl)}</code></div><div class="muted">Pour désinstaller : Stremio → Addons → cet addon → Désinstaller. La molette ⚙️ rouvre cette page.</div></section>
<section><h2>État du calcul</h2><div id="st" class="muted">chargement…</div><progress id="pg" max="100" value="0" style="display:none"></progress>
<button class="btn sec" id="rb" type="button">⟳ Forcer un rebuild / une nouvelle synchronisation</button><div class="muted">Contourne la limite « une synchronisation par jour » (utile après un déploiement). <b>Garde cette page ouverte pendant le calcul</b> : elle interroge le serveur toutes les quelques secondes, ce qui l'empêche de s'endormir (Render Free).</div></section>` : ''}
<form method="post" action="${action}">
<section><h2>Connexions</h2>
${keyField('tmdb', 'TMDB — API Read Access Token', view, true, 'Le long jeton « API Read Access Token » (pas la clé API courte).')}
${keyField('stremio', 'Stremio — AuthKey', view, true, 'Stockée chiffrée côté serveur. Jamais dans l\'URL du manifest.')}
${keyField('gemini', 'Gemini — clé API (Google AI Studio)', view, false, 'Facultatif. Sans clé ou en cas d\'erreur/quota, le moteur local continue seul.')}
${edit && view.has.gemini ? '<label class="chk"><input type="checkbox" name="clearGemini" value="1">Supprimer la clé Gemini enregistrée</label>' : ''}
${keyField('rapidapi', 'Streaming Availability (RapidAPI) — clé API', view, false, 'Facultatif. Sert à détecter la VF des séries (mode information). Sans clé, la détection est inactive.')}
<div class="muted">Un champ laissé vide conserve la valeur déjà enregistrée.</div></section>
<section><h2>🎬 Films</h2><label>Note et votes minimum</label><select name="movie.ratingMode"><option value="auto" ${s.movie.ratingMode !== 'manual' ? 'selected' : ''}>Automatique (calculé sur tes ❤️/👍, notes IMDb ; repli TMDB)</option><option value="manual" ${s.movie.ratingMode === 'manual' ? 'selected' : ''}>Manuel (champs ci-dessous)</option></select><div class="grid"><div><label>Note IMDb minimale (mode manuel)</label><input type="number" step="0.1" min="0" max="10" name="movie.minRating" value="${s.movie.minRating}"></div><div><label>Votes IMDb minimum (mode manuel)</label><input type="number" min="0" name="movie.minVotes" value="${s.movie.minVotes}"></div><div><label>Durée minimale (min)</label><input type="number" min="0" name="movie.minRuntime" value="${s.movie.minRuntime}"></div><div><label>Année minimale (0 = aucune)</label><input type="number" min="0" max="2100" name="movie.minYear" value="${s.movie.minYear ?? 0}"></div><div><label>Ordre du catalogue</label><select name="movie.order">${opt('score', s.movie.order)}${opt('random', s.movie.order)}</select></div></div>
<label class="chk"><input type="checkbox" name="movie.noWesternAnimation" value="1" ${s.movie.noWesternAnimation ? 'checked' : ''}>Exclure toute l'animation sauf japonaise (anime conservé)</label><label>Genres à exclure</label>${genreBoxes('movie', MOVIE_GENRES, s.movie.exclude)}</section>
<section><h2>📺 Séries</h2><label>Note et votes minimum</label><select name="series.ratingMode"><option value="auto" ${s.series.ratingMode !== 'manual' ? 'selected' : ''}>Automatique (calculé sur tes ❤️/👍, notes IMDb ; repli TMDB)</option><option value="manual" ${s.series.ratingMode === 'manual' ? 'selected' : ''}>Manuel (champs ci-dessous)</option></select><div class="grid"><div><label>Note IMDb minimale (mode manuel)</label><input type="number" step="0.1" min="0" max="10" name="series.minRating" value="${s.series.minRating}"></div><div><label>Votes IMDb minimum (mode manuel)</label><input type="number" min="0" name="series.minVotes" value="${s.series.minVotes}"></div><div><label>Année minimale (0 = aucune)</label><input type="number" min="0" max="2100" name="series.minYear" value="${s.series.minYear ?? 0}"></div><div><label>Ordre du catalogue</label><select name="series.order">${opt('score', s.series.order)}${opt('random', s.series.order)}</select></div></div>
<label class="chk"><input type="checkbox" name="series.noWesternAnimation" value="1" ${s.series.noWesternAnimation ? 'checked' : ''}>Exclure toute l'animation sauf japonaise (anime conservé)</label>
<label class="chk"><input type="checkbox" name="series.vfCheck" value="1" ${s.series.vfCheck !== false ? 'checked' : ''}>Détection VF (API Streaming Availability) — écarte les séries d'origine asiatique ou turque sans VF (VOSTFR, VO seule ou absente des plateformes FR) ; le diagnostic affiche le statut de chaque série. Décocher = comportement d'avant</label>
<div class="muted" id="vfst">API VF : état inconnu</div><button class="btn sec" type="button" id="vft">Tester maintenant (1 requête)</button><label>Genres à exclure</label>${genreBoxes('series', TV_GENRES, s.series.exclude)}<div class="muted">TMDB n'a pas de genre Horreur/Romance/Musique pour les séries : ces cases (et Sitcom) détectent par mots-clés.</div></section>
<section><h2>Options communes</h2>
<label class="chk"><input type="checkbox" name="common.movieCatalog" value="1" ${s.common.movieCatalog ? 'checked' : ''}>Catalogue Films activé</label>
<label class="chk"><input type="checkbox" name="common.seriesCatalog" value="1" ${s.common.seriesCatalog ? 'checked' : ''}>Catalogue Séries activé</label>
<label class="chk"><input type="checkbox" name="common.libMovieCatalog" value="1" ${s.common.libMovieCatalog !== false ? 'checked' : ''}>📌 Catalogue « Votre liste de lecture » — Films (toute ta bibliothèque Stremio, vus et non vus)</label>
<label class="chk"><input type="checkbox" name="common.libSeriesCatalog" value="1" ${s.common.libSeriesCatalog !== false ? 'checked' : ''}>📌 Catalogue « Votre liste de lecture » — Séries (toute ta bibliothèque Stremio, vus et non vus)</label>
<div class="muted">Ajouter ou retirer un catalogue change la carte d'identité de l'addon : après avoir enregistré, réinstalle-le dans Stremio (bouton « Installer / mettre à jour ») pour que l'accueil se mette à jour.</div>
<label class="chk"><input type="checkbox" name="common.excludeCancelled" value="1" ${s.common.excludeCancelled ? 'checked' : ''}>Exclure les séries annulées</label>
<label class="chk"><input type="checkbox" name="common.frMeta" value="1" ${s.common.frMeta ? 'checked' : ''}>Fournir les fiches en français (/meta) — nécessite de réinstaller/mettre à jour l'addon dans Stremio si modifié</label>
<label class="chk"><input type="checkbox" name="common.useGemini" value="1" ${s.common.useGemini ? 'checked' : ''}>Utiliser Gemini (comparaison de chaque candidat à ses titres adorés et non aimés les plus proches) quand une clé est enregistrée</label>
</section>
<button class="btn" type="submit">${edit ? 'Enregistrer' : 'Créer mon addon'}</button>
<div class="muted" style="margin-top:8px">Modifier un filtre relance immédiatement le calcul des seuls catalogues concernés, sans réapprendre le profil. Changer l'ordre d'affichage ne relance aucun calcul.</div></form>
${edit ? `<script>
const id=${JSON.stringify(view.id)};const st=document.getElementById('st'),pg=document.getElementById('pg');
const fmt=t=>t?new Date(t).toLocaleString('fr-CH',{timeZone:'Europe/Zurich'}):'—';
async function poll(){try{const r=await fetch('/u/'+id+'/status',{cache:'no-store'});const s=await r.json();
let h='';if(s.running){const p=s.progress||{};h='⏳ <b>Calcul en cours</b> — '+(p.label||s.stage||'')+(p.total?' ('+p.done+'/'+p.total+')':'');pg.style.display=p.total?'block':'none';if(p.total){pg.max=p.total;pg.value=p.done||0}}
else{pg.style.display='none';h='Films : <b>'+s.ready.movie+'</b> titres · Séries : <b>'+s.ready.series+'</b> titres<br>Dernier succès : '+fmt(s.lastSuccessAt)+(s.lastRun?'<br>Dernier calcul : '+(s.lastRun.ok?'✅ '+s.lastRun.outcome+' en '+s.lastRun.durationHuman:'❌ '+(s.lastRun.error||'échec')):'')}
st.innerHTML=h;const v=s.vf;if(v){const dot={green:'🟢',red:'🔴',grey:'⚪'}[v.pastille]||'⚪';document.getElementById('vfst').innerHTML=dot+' API VF : '+(!v.hasKey?'aucune clé enregistrée':v.pastille==='green'?'en ligne (dernier succès '+fmt(v.lastOkAt)+')':v.pastille==='red'?'hors ligne — '+(v.lastError||'erreur')+' (dernier échec '+fmt(v.lastFailAt)+')':'jamais interrogée')+' · '+v.cache+' séries en cache · '+v.callsToday+' requête(s) aujourd’hui'+(v.enabled?'':' · détection désactivée')}setTimeout(poll,s.running?4000:15000)}catch(e){st.textContent='statut indisponible';setTimeout(poll,15000)}}
document.getElementById('rb').onclick=async()=>{const r=await fetch('/u/'+id+'/rebuild',{method:'POST'});const j=await r.json();st.textContent=j.started?'⏳ Calcul lancé…':'ℹ️ '+(j.why||'déjà en cours');poll()};document.getElementById('vft').onclick=async()=>{const e=document.getElementById('vfst');e.textContent='⏳ test en cours…';try{const r=await fetch('/u/'+id+'/vf-test',{method:'POST'});const j=await r.json();e.textContent=({green:'🟢',red:'🔴',grey:'⚪'}[j.pastille]||'⚪')+' '+j.message}catch(x){e.textContent='🔴 test impossible'}setTimeout(poll,3000)};poll();</script>` : ''}
</body></html>`;
}
module.exports = { page };
