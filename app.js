/* Burger Rankings — page code. Pure ranking/checker logic lives in logic.js. */
(function () {
  'use strict';

  const L = window.BurgerLogic;
  const CFG = window.BURGER_CONFIG || {};
  const API = /^https:\/\/script\.google(usercontent)?\.com\//.test(CFG.api || '') ? CFG.api : '';
  const KEYS = { data: 'burgers.data.v1', code: 'burgers.code', queue: 'burgers.queue.v1', checks: 'burgers.checks.v1' };
  const TIMEOUT_MS = 20000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: run without storage */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const state = {
    rankings: [], ranked: [], formula: L.parseFormula([]), tutorial: [], fetchedAt: null,
    code: store.get(KEYS.code, ''), queue: store.get(KEYS.queue, []),
    checked: store.get(KEYS.checks, {}),
    filters: { query: '', city: '', minScore: null, restaurant: '' },
    open: null, highlight: null, editing: null,
    offline: false, error: '', loaded: false, view: 'rankings',
  };

  /* --------------------------------------------------------------- network */

  class NetworkError extends Error {}

  async function call(url, init) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, Object.assign({ signal: ctrl.signal, redirect: 'follow' }, init));
    } catch (e) {
      throw new NetworkError('No connection');
    } finally {
      clearTimeout(t);
    }
    let body;
    try { body = await res.json(); } catch (e) { throw new Error('The sheet sent back something unexpected (HTTP ' + res.status + '). Check the Apps Script deployment.'); }
    return body;
  }

  const apiGet = () => call(API + (API.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now(), { cache: 'no-store' });
  const apiPost = (body) => call(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });

  async function refresh(manual) {
    if (!API) { render(); return; }
    try {
      const data = await apiGet();
      if (!data.ok) throw new Error(data.error || 'The sheet refused the request');
      state.offline = false; state.error = '';
      applyData(data);
      store.set(KEYS.data, { rankings: data.rankings, formula: data.formula, tutorial: data.tutorial, fetchedAt: data.fetchedAt });
      if (manual) toast('Up to date with the sheet');
      flushQueue();
    } catch (e) {
      if (e instanceof NetworkError) state.offline = true;
      else state.error = e.message;
    }
    state.loaded = true;
    render();
  }

  /* ------------------------------------------------------------------ data */

  function applyData(d) {
    if (d.rankings) state.rankings = d.rankings;
    if (d.formula) state.formula = L.parseFormula(d.formula);
    if (d.tutorial) state.tutorial = L.groupTutorial(d.tutorial);
    if (d.fetchedAt) state.fetchedAt = d.fetchedAt;
    rerank();
  }

  function rerank() {
    const pending = state.queue.map((q) => Object.assign({}, q.burger, { pending: true }));
    state.ranked = L.rank(state.rankings.concat(pending));
  }

  function saveRankings(rankings) {
    state.rankings = rankings;
    state.fetchedAt = new Date().toISOString();
    const cached = store.get(KEYS.data, {});
    cached.rankings = rankings; cached.fetchedAt = state.fetchedAt;
    store.set(KEYS.data, cached);
    rerank();
  }

  /* ------------------------------------------------------------- rendering */

  function render() {
    renderChrome();
    renderRankings();
    renderSpots();
    renderCheck();
    renderTutorial();
  }

  function renderChrome() {
    const n = state.ranked.length;
    const spots = new Set(state.ranked.map((r) => L.fold(r.restaurant))).size;
    const filtered = filteredRows().length;
    const filtering = state.view === 'rankings' && filtered !== n;
    let sub = n ? (filtering ? filtered + ' of ' + n + ' burgers' : n + ' burgers from ' + spots + ' spots') : '';
    if (state.queue.length) sub += (sub ? '. ' : '') + state.queue.length + ' waiting to sync';
    $('sub').textContent = sub;

    $('addBtn').hidden = !state.code || !API;
    $('codeItem').hidden = !!state.code;
    $('forgetItem').hidden = !state.code;

    const b = $('banner');
    let msg = '';
    if (!API) msg = '<strong>Not connected to the sheet yet.</strong> Put your Apps Script web app URL in config.js.';
    else if (state.error) msg = '<strong>Couldn\'t load the sheet.</strong> ' + esc(state.error) + ' <button data-act="refresh">Try again</button>';
    else if (state.offline) msg = '<strong>No connection.</strong> ' + (state.fetchedAt ? 'Showing the list as of ' + esc(when(state.fetchedAt)) + '.' : 'Open the app again when you have signal.') + ' <button data-act="refresh">Try again</button>';
    else if (!state.loaded && !state.ranked.length) msg = 'Loading the rankings…';
    b.innerHTML = msg;
    b.hidden = !msg;

    // Datalists for the editor
    const rest = [...new Set(state.rankings.map((r) => r.restaurant))].sort();
    const cities = [...new Set(state.rankings.map((r) => r.city).filter(Boolean))].sort();
    $('restaurantList').innerHTML = rest.map((r) => '<option value="' + esc(r) + '">').join('');
    $('cityList').innerHTML = cities.map((c) => '<option value="' + esc(c) + '">').join('');
  }

  function filteredRows() {
    return L.search(state.ranked, state.filters);
  }

  function chip(score, tier, extra) {
    return '<span class="sear ' + tier + '"' + (extra || '') + '>' + esc(score) + '</span>';
  }

  function where(r) {
    const city = String(r.city || '').trim();
    if (!city) return r.restaurant;
    if (/^\(chain\)$/i.test(city)) return r.restaurant + ' (chain)';
    return r.restaurant + ', ' + city;
  }

  function renderRankings() {
    // City select
    const sel = $('city');
    const opts = ['<option value="">All places</option>'].concat(
      L.cities(state.ranked).map((c) => '<option value="' + esc(c.city) + '">' + esc(c.city) + ' (' + c.count + ')</option>'));
    const html = opts.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = state.filters.city;

    $('onlyRec').setAttribute('aria-pressed', String(state.filters.minScore != null));
    $('onlyRec').textContent = state.formula.thresholds.good.toFixed(1) + ' and up';
    const cr = $('clearRest');
    cr.hidden = !state.filters.restaurant;
    cr.textContent = state.filters.restaurant;
    cr.setAttribute('aria-label', 'Show all restaurants, not just ' + state.filters.restaurant);

    const rows = filteredRows();
    const t = state.formula.thresholds;
    const parts = [];
    let lastTier = null;
    const counts = rows.reduce((m, r) => { const k = L.tierOf(r.score, t); m[k] = (m[k] || 0) + 1; return m; }, {});
    rows.forEach((r) => {
      const tier = L.tierOf(r.score, t);
      if (tier !== lastTier) {
        const tt = L.TIER_TEXT[tier];
        parts.push('<li class="tier" role="presentation"><span><span class="swatch ' + tier + '"></span>' + esc(tt.name) +
          '</span><span class="range">' + counts[tier] + (tier === 'skip' ? ' ' : ' at ') + esc(tt.range(t)) + '</span></li>');
        lastTier = tier;
      }
      const open = state.open === r.id;
      const moved = state.highlight === r.id ? ' moved' : '';
      parts.push(
        '<li class="row' + moved + '" data-id="' + esc(r.id) + '">' +
        '<button aria-expanded="' + open + '" data-toggle="' + esc(r.id) + '">' +
        '<span class="rank">' + r.rank + '</span>' +
        '<span><span class="name">' + esc(r.burger) + (r.pending ? '<span class="pending-tag">Not synced</span>' : '') + '</span>' +
        '<span class="where">' + esc(where(r)) + '</span></span>' +
        chip(r.score.toFixed(1), tier, ' aria-label="Score ' + r.score.toFixed(1) + '"') +
        '</button>' + (open ? detailHtml(r) : '') + '</li>');
    });
    $('list').innerHTML = parts.join('');

    const empty = $('listEmpty');
    if (!rows.length && state.ranked.length) {
      empty.innerHTML = 'No burgers match. <button data-act="clear-filters">Clear the filters</button>';
      empty.hidden = false;
    } else if (!state.ranked.length && state.loaded && API && !state.offline && !state.error) {
      empty.textContent = 'No burgers on the sheet yet.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function detailHtml(r) {
    const sameSpot = state.ranked.filter((x) => L.fold(x.restaurant) === L.fold(r.restaurant)).length;
    const bits = [];
    bits.push(r.notes ? '<p>' + esc(r.notes) + '</p>' : '<p class="muted">No notes yet.</p>');
    const actions = [];
    if (/^https?:\/\//i.test(r.link || '')) actions.push('<a class="ghost" href="' + esc(r.link) + '" target="_blank" rel="noopener">Open the menu</a>');
    if (sameSpot > 1 && !state.filters.restaurant) actions.push('<button class="ghost" data-rest="' + esc(r.restaurant) + '">All ' + sameSpot + ' from ' + esc(r.restaurant) + '</button>');
    if (state.code && API && !r.pending) actions.push('<button class="ghost" data-edit="' + esc(r.id) + '">Edit</button>');
    if (r.pending) bits.push('<p class="muted">Saved on this phone. It goes to the sheet when you have signal.</p>');
    if (actions.length) bits.push('<div class="detail-actions">' + actions.join('') + '</div>');
    return '<div class="detail">' + bits.join('') + '</div>';
  }

  function renderSpots() {
    const multi = $('multiOnly').checked;
    const stats = L.restaurantStats(state.ranked, multi ? 2 : 1);
    const t = state.formula.thresholds;
    $('spots').innerHTML = stats.map((s) => {
      const best = s.count > 1 ? s.count + ' burgers, best is ' + s.best.burger + ' (' + s.best.score.toFixed(1) + ')' : s.best.burger;
      const avg = s.avg.toFixed(s.count > 1 ? 2 : 1);
      return '<li class="row"><button data-rest="' + esc(s.restaurant) + '" aria-label="' + esc(s.restaurant) + ', average ' + avg + '. Show its burgers">' +
        '<span><span class="name">' + esc(s.restaurant) + '</span><span class="spot-meta">' + esc(s.city.replace('Chains', 'Chain')) + '. ' + esc(best) + '</span></span>' +
        chip(avg, L.tierOf(s.avg, t)) + '</button></li>';
    }).join('') || '<li class="empty">No spots yet.</li>';
  }

  const GROUP_WHY = {
    must: (g, n) => 'Every ' + (g.threshold || 8).toFixed(1) + '+ burger had all ' + n + '.',
    boost: (g) => 'With every must-have, two of these are what push past ' + (g.threshold || 8.4).toFixed(1) + '.',
    avoid: () => 'Each one caps the score at the best you\'ve given a burger with it.',
    info: () => '',
  };

  function renderCheck() {
    const groups = state.formula.groups;
    if (!groups.length) {
      $('checklist').innerHTML = '<p class="empty">The Perfect Burger Formula tab hasn\'t loaded yet.</p>';
      $('verdict').innerHTML = '';
      return;
    }
    const html = groups.filter((g) => g.kind !== 'info').map((g) => {
      const items = g.items.map((it) => {
        const id = 'chk-' + it.id;
        const cap = g.kind === 'avoid' ? '<span class="cap">' + (it.cap != null ? 'best ' + it.cap.toFixed(1) : '') + '</span>' : '<span></span>';
        return '<label class="check" for="' + id + '"><input type="checkbox" id="' + id + '" data-check="' + it.id + '"' + (state.checked[it.id] ? ' checked' : '') + '>' +
          '<span><b>' + esc(it.element) + '</b><span class="spec">' + esc(it.spec) + '</span></span>' + cap + '</label>';
      }).join('');
      return '<section class="group"><h2>' + esc(g.title) + '</h2><p class="why">' + esc(GROUP_WHY[g.kind](g, g.items.length)) + '</p>' + items + '</section>';
    }).join('');
    if ($('checklist').dataset.html !== html) { $('checklist').innerHTML = html; $('checklist').dataset.html = html; }
    renderVerdict();
  }

  function renderVerdict() {
    const p = L.predict(state.formula, state.checked);
    const v = $('verdict');
    if (p.empty) {
      v.innerHTML = '<p class="hint">Tick what the menu says about a burger. The verdict shows here.</p>';
      return;
    }
    v.innerHTML = '<div class="big">' + chip(p.band, p.verdict) +
      '<span class="label">' + esc(p.label) + '<small>Ceiling from your formula</small></span></div>' +
      '<ul>' + p.reasons.map((r) => '<li class="' + (r.good ? 'good' : '') + '">' + esc(r.text) + '</li>').join('') + '</ul>';
  }

  function renderTutorial() {
    const el = $('tutorial');
    const html = state.tutorial.map((g, i) =>
      '<details class="step-group"' + (i === 0 ? ' open' : '') + '><summary><span class="n">' + esc(g.title.num) + '</span><span>' + esc(g.title.text) + '</span></summary>' +
      g.items.map((it) => '<div class="tip"><b>' + esc(it.element) + '</b><p>' + esc(it.spec) + '</p>' + (it.detail ? '<p class="why">' + esc(it.detail) + '</p>' : '') + '</div>').join('') +
      '</details>').join('') || '<p class="empty">The tutorial tab hasn\'t loaded yet.</p>';
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  /* --------------------------------------------------------------- routing */

  const VIEWS = ['rankings', 'spots', 'check', 'cook'];

  function route() {
    const h = location.hash.replace('#', '');
    const view = VIEWS.indexOf(h) !== -1 ? h : 'rankings';
    const changed = view !== state.view;
    state.view = view;
    VIEWS.forEach((v) => {
      $('view-' + v).hidden = v !== view;
      $('tab-' + v).setAttribute('aria-selected', String(v === view));
    });
    renderChrome();
    if (changed) window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------- editor */

  function openEditor(row) {
    state.editing = row ? row.id : null;
    const f = $('form');
    f.reset();
    $('formError').hidden = true;
    $('editorTitle').textContent = row ? 'Edit burger' : 'Add a burger';
    $('saveBtn').textContent = row ? 'Save changes' : 'Save burger';
    $('deleteBtn').hidden = !row;
    if (row) {
      f.burger.value = row.burger; f.score.value = row.score.toFixed(1); f.restaurant.value = row.restaurant;
      f.city.value = row.city || ''; f.link.value = row.link || ''; f.notes.value = row.notes || '';
    } else if (state.filters.restaurant) {
      const r = state.ranked.find((x) => L.fold(x.restaurant) === L.fold(state.filters.restaurant));
      if (r) { f.restaurant.value = r.restaurant; f.city.value = r.city || ''; }
    }
    updatePreview();
    $('editor').showModal();
    if (!row) f.burger.focus();
  }

  function updatePreview() {
    const v = $('form').score.value;
    const p = $('preview');
    if (v === '' || !isFinite(Number(v)) || Number(v) < 0 || Number(v) > 10) { p.textContent = ''; return; }
    const s = Math.round(Number(v) * 10) / 10;
    const pr = L.previewRank(state.ranked, s, state.editing);
    const tier = L.tierOf(s, state.formula.thresholds);
    p.innerHTML = chip(s.toFixed(1), tier) + 'Lands at #' + pr.rank + ' of ' + pr.of + ', ' + esc(L.TIER_TEXT[tier].name.toLowerCase());
  }

  function readForm() {
    const f = $('form');
    const val = (n) => f[n].value.replace(/\s+/g, ' ').trim();
    const b = { burger: val('burger'), score: f.score.value.trim(), restaurant: val('restaurant'), city: val('city'), link: val('link'), notes: val('notes') };
    if (!b.burger) return { error: 'Give the burger a name.', field: 'burger' };
    const s = Number(b.score);
    if (b.score === '' || !isFinite(s) || s < 0 || s > 10) return { error: 'Score needs to be a number from 0 to 10.', field: 'score' };
    b.score = Math.round(s * 10) / 10;
    if (!b.restaurant) return { error: 'Which restaurant was it?', field: 'restaurant' };
    if (b.link && !/^https?:\/\//i.test(b.link)) return { error: 'The menu link has to start with https://', field: 'link' };
    const dup = state.ranked.find((r) => r.id === L.key(b.burger, b.restaurant) && r.id !== state.editing);
    if (dup) return { error: b.burger + ' at ' + b.restaurant + ' is already on the list.', field: 'burger' };
    return { burger: b };
  }

  function formError(msg, field) {
    const e = $('formError');
    e.textContent = msg; e.hidden = false;
    if (field) $('form')[field].focus();
  }

  async function save(ev) {
    ev.preventDefault();
    const r = readForm();
    if (r.error) return formError(r.error, r.field);
    const editing = state.editing ? state.ranked.find((x) => x.id === state.editing) : null;
    const body = editing
      ? { code: state.code, action: 'edit', match: { burger: editing.burger, restaurant: editing.restaurant }, burger: r.burger }
      : { code: state.code, action: 'add', burger: r.burger };
    await send(body, r.burger, !!editing);
  }

  async function removeBurger() {
    const row = state.ranked.find((x) => x.id === state.editing);
    if (!row || !confirm('Delete ' + row.burger + ' from the list? This removes its row from the sheet.')) return;
    await send({ code: state.code, action: 'delete', match: { burger: row.burger, restaurant: row.restaurant } }, row, true);
  }

  async function send(body, burger, mustBeOnline) {
    const btn = body.action === 'delete' ? $('deleteBtn') : $('saveBtn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = body.action === 'delete' ? 'Deleting…' : 'Saving…';
    try {
      const res = await apiPost(body);
      if (res.auth === false) { forgetCode(); return formError('This phone\'s edit code no longer works. Open your setup link again.'); }
      if (!res.ok) return formError(res.error || 'The sheet refused that change.');
      state.offline = false;
      saveRankings(res.rankings);
      $('editor').close();
      if (body.action === 'delete') {
        state.open = null;
        toast('Deleted ' + burger.burger);
      } else {
        const id = L.key(burger.burger, burger.restaurant);
        const now = state.ranked.find((x) => x.id === id);
        state.open = id; state.highlight = id;
        toast('Saved ' + burger.burger + (now ? ' at #' + now.rank : ''));
      }
      if (body.action !== 'delete') clearFiltersHiding(burger);
      render();
      scrollToRow(state.highlight);
    } catch (e) {
      if (e instanceof NetworkError && !mustBeOnline) {
        state.queue.push({ qid: Date.now() + '-' + Math.random().toString(36).slice(2, 7), burger: burger });
        store.set(KEYS.queue, state.queue);
        rerank();
        $('editor').close();
        state.offline = true;
        toast('No signal. Saved on this phone; it syncs when you\'re back online.');
        render();
      } else if (e instanceof NetworkError) {
        formError('No connection. Try again when you have signal.');
      } else {
        formError(e.message);
      }
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  /** Make sure a just-saved burger isn't hidden by the current filters. */
  function clearFiltersHiding(b) {
    if (!b || !b.burger) return;
    const id = L.key(b.burger, b.restaurant);
    if (!filteredRows().some((r) => r.id === id)) state.filters = { query: '', city: '', minScore: null, restaurant: '' };
    $('q').value = state.filters.query;
  }

  function scrollToRow(id) {
    if (!id) return;
    if (location.hash !== '#rankings' && state.view !== 'rankings') location.hash = '#rankings';
    requestAnimationFrame(() => {
      const el = document.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
      if (el) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      setTimeout(() => { state.highlight = null; }, 1500);
    });
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing || !state.queue.length || !state.code || !API) return;
    flushing = true;
    try {
      while (state.queue.length) {
        const item = state.queue[0];
        let res;
        try {
          res = await apiPost({ code: state.code, action: 'add', burger: item.burger });
        } catch (e) {
          if (e instanceof NetworkError) { state.offline = true; break; }
          throw e;
        }
        if (res.auth === false) { forgetCode(); toast('Edit code stopped working, so ' + state.queue.length + ' unsynced burger(s) are waiting.'); break; }
        state.queue.shift();
        store.set(KEYS.queue, state.queue);
        if (res.ok) { saveRankings(res.rankings); toast('Synced ' + item.burger.burger); }
        else { rerank(); toast('Couldn\'t add ' + item.burger.burger + ': ' + res.error); }
      }
    } finally {
      flushing = false;
      render();
    }
  }

  /* ------------------------------------------------------------ edit code */

  function takeCodeFromHash() {
    const m = location.hash.match(/code=([A-Za-z0-9]+)/);
    if (!m) return false;
    state.code = m[1];
    store.set(KEYS.code, state.code);
    history.replaceState(null, '', location.pathname + location.search + '#rankings');
    return true;
  }

  async function verifyCode(announce) {
    if (!state.code || !API) return;
    try {
      const res = await apiPost({ code: state.code, action: 'check' });
      if (res.auth === false) { forgetCode(); toast('That edit code didn\'t work. Check the Apps Script log.'); }
      else if (res.ok && announce) toast('Editing is on for this phone');
    } catch (e) { /* offline: keep the code and try again later */ }
    render();
  }

  function forgetCode() {
    state.code = '';
    store.del(KEYS.code);
    render();
  }

  /* -------------------------------------------------------------- helpers */

  function when(iso) {
    const d = new Date(iso);
    return isNaN(d) ? 'earlier' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  async function share() {
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) { await navigator.share({ title: 'Burger Rankings', url: url }); return; }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (e) { /* share sheet dismissed */ }
  }

  function closeMenu() { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false'); }

  /* --------------------------------------------------------------- events */

  function wire() {
    window.addEventListener('hashchange', () => { if (!takeCodeFromHash()) route(); else { route(); verifyCode(true); } });

    let qTimer;
    $('q').addEventListener('input', (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        if (state.filters.query === e.target.value) return;
        state.filters.query = e.target.value; state.open = null; renderRankings(); renderChrome();
      }, 80);
    });
    $('city').addEventListener('change', (e) => { state.filters.city = e.target.value; state.open = null; renderRankings(); renderChrome(); });
    $('onlyRec').addEventListener('click', () => {
      state.filters.minScore = state.filters.minScore == null ? state.formula.thresholds.good : null;
      renderRankings(); renderChrome();
    });
    $('clearRest').addEventListener('click', () => { state.filters.restaurant = ''; renderRankings(); renderChrome(); });
    $('multiOnly').addEventListener('change', renderSpots);

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle],[data-rest],[data-edit],[data-act]');
      if (!t) {
        if (!e.target.closest('#menu, #menuBtn')) closeMenu();
        return;
      }
      if (t.dataset.toggle) {
        state.open = state.open === t.dataset.toggle ? null : t.dataset.toggle;
        renderRankings();
      } else if (t.dataset.rest) {
        state.filters = { query: '', city: '', minScore: null, restaurant: t.dataset.rest };
        $('q').value = '';
        state.open = null;
        if (location.hash !== '#rankings') location.hash = '#rankings';
        renderRankings(); renderChrome(); window.scrollTo(0, 0);
      } else if (t.dataset.edit) {
        openEditor(state.ranked.find((r) => r.id === t.dataset.edit));
      } else if (t.dataset.act) {
        closeMenu();
        const a = t.dataset.act;
        if (a === 'refresh') refresh(true);
        else if (a === 'share') share();
        else if (a === 'clear-filters') { state.filters = { query: '', city: '', minScore: null, restaurant: '' }; $('q').value = ''; renderRankings(); renderChrome(); }
        else if (a === 'forget') { forgetCode(); toast('Editing is off for this phone'); }
        else if (a === 'code') {
          const c = (prompt('Paste the edit code from your Apps Script log') || '').trim();
          if (/^[A-Za-z0-9]{6,}$/.test(c)) { state.code = c; store.set(KEYS.code, c); verifyCode(true); }
          else if (c) toast('That doesn\'t look like an edit code');
        }
      }
    });

    $('menuBtn').addEventListener('click', () => {
      const m = $('menu');
      m.hidden = !m.hidden;
      $('menuBtn').setAttribute('aria-expanded', String(!m.hidden));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

    $('addBtn').addEventListener('click', () => openEditor(null));
    $('closeEditor').addEventListener('click', () => $('editor').close());
    $('form').addEventListener('submit', save);
    $('form').score.addEventListener('input', updatePreview);
    $('deleteBtn').addEventListener('click', removeBurger);
    document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
      const f = $('form');
      const cur = f.score.value === '' ? 7.0 - Number(b.dataset.step) : Number(f.score.value);
      const next = Math.min(10, Math.max(0, Math.round((cur + Number(b.dataset.step)) * 10) / 10));
      f.score.value = next.toFixed(1);
      updatePreview();
    }));
    $('editor').addEventListener('click', (e) => { if (e.target === $('editor')) $('editor').close(); });

    $('checklist').addEventListener('change', (e) => {
      const id = e.target.dataset.check;
      if (!id) return;
      if (e.target.checked) state.checked[id] = true; else delete state.checked[id];
      store.set(KEYS.checks, state.checked);
      renderVerdict();
    });
    $('resetCheck').addEventListener('click', () => {
      state.checked = {};
      store.set(KEYS.checks, state.checked);
      document.querySelectorAll('[data-check]').forEach((c) => { c.checked = false; });
      renderVerdict();
      window.scrollTo(0, 0);
    });

    window.addEventListener('online', () => { state.offline = false; refresh(); });
    window.addEventListener('offline', () => { state.offline = true; renderChrome(); });
  }

  /* ----------------------------------------------------------------- init */

  function trackHeaderHeight() {
    const set = () => document.documentElement.style.setProperty('--top-h', document.querySelector('.top').offsetHeight + 'px');
    set();
    if (window.ResizeObserver) new ResizeObserver(set).observe(document.querySelector('.top'));
  }

  function init() {
    trackHeaderHeight();
    const gotCode = takeCodeFromHash();
    const cached = store.get(KEYS.data, null);
    if (cached) applyData(cached); else rerank();
    wire();
    route();
    render();
    refresh().then(() => { if (state.code) verifyCode(gotCode); });
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
    }
  }

  init();
})();
