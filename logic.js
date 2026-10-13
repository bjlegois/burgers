/*
 * Pure logic for the burger app — no DOM, no network — so it can be tested
 * in Node and reused by the page. Exposed as window.BurgerLogic in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurgerLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Your own line from the notes: under 7.0 isn't a recommend. */
  const RECOMMEND_LINE = 7.0;
  const DEFAULT_THRESHOLDS = { elite: 8.4, great: 8.0, good: RECOMMEND_LINE };

  /* ---------------------------------------------------------------- text */

  /** Lower-case, accent-free, single-spaced: "Jalapeño" matches "jalapeno". */
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function key(burger, restaurant) {
    return fold(burger) + '|' + fold(restaurant);
  }

  /** "Green Bay (Ashwaubenon), WI" → "Green Bay"; "(chain)" → "Chains". */
  function baseCity(city) {
    const c = String(city || '').trim();
    if (!c || /^\(?chain\)?$/i.test(c)) return 'Chains';
    const noParens = c.replace(/\([^)]*\)/g, '').trim();
    const first = noParens.split(',')[0].trim();
    return first || 'Chains';
  }

  /* ------------------------------------------------------------- ranking */

  /**
   * Rank by score, high to low. Ties keep sheet order — the same rule the
   * sheet uses — so the app agrees with the Rank column after any edit.
   */
  function rank(rows) {
    return (rows || [])
      .map(function (r, i) {
        const score = typeof r.score === 'number' ? r.score : parseFloat(r.score);
        return Object.assign({}, r, { score: score, _order: i, id: key(r.burger, r.restaurant) });
      })
      .filter(function (r) { return r.burger && isFinite(r.score); })
      .sort(function (a, b) { return b.score - a.score || a._order - b._order; })
      .map(function (r, i) { r.rank = i + 1; delete r._order; return r; });
  }

  /**
   * Where a burger would land. New burgers (or ones whose score changed) go
   * to the bottom of their tie group, matching the sheet script.
   */
  function previewRank(ranked, score, editingId) {
    const s = Number(score);
    if (!isFinite(s)) return null;
    const others = ranked.filter(function (r) { return r.id !== editingId; });
    if (editingId) {
      const self = ranked.find(function (r) { return r.id === editingId; });
      if (self && self.score === Math.round(s * 10) / 10) return { rank: self.rank, of: ranked.length };
    }
    const ahead = others.filter(function (r) { return r.score >= Math.round(s * 10) / 10; }).length;
    return { rank: ahead + 1, of: others.length + 1 };
  }

  function tierOf(score, t) {
    t = t || DEFAULT_THRESHOLDS;
    if (score >= t.elite) return 'elite';
    if (score >= t.great) return 'great';
    if (score >= t.good) return 'good';
    return 'skip';
  }

  const TIER_TEXT = {
    elite: { name: 'Elite', range: function (t) { return t.elite.toFixed(1) + ' and up'; } },
    great: { name: 'Very good', range: function (t) { return t.great.toFixed(1) + ' to ' + (t.elite - 0.1).toFixed(1); } },
    good: { name: 'Worth ordering', range: function (t) { return t.good.toFixed(1) + ' to ' + (t.great - 0.1).toFixed(1); } },
    skip: { name: 'Below your recommend line', range: function (t) { return 'under ' + t.good.toFixed(1); } },
  };

  /* ------------------------------------------------------------- search */

  function search(ranked, opts) {
    opts = opts || {};
    const words = fold(opts.query).split(' ').filter(Boolean);
    return ranked.filter(function (r) {
      if (opts.city && baseCity(r.city) !== opts.city) return false;
      if (opts.restaurant && fold(r.restaurant) !== fold(opts.restaurant)) return false;
      if (opts.minScore != null && r.score < opts.minScore) return false;
      if (!words.length) return true;
      const hay = fold([r.burger, r.restaurant, r.city, r.notes].join(' '));
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
  }

  function cities(ranked) {
    const counts = {};
    ranked.forEach(function (r) { const c = baseCity(r.city); counts[c] = (counts[c] || 0) + 1; });
    return Object.keys(counts)
      .map(function (c) { return { city: c, count: counts[c] }; })
      .sort(function (a, b) { return b.count - a.count || a.city.localeCompare(b.city); });
  }

  /* ---------------------------------------------------- restaurant stats */

  /** Averages computed live from the rankings, so they can't go stale. */
  function restaurantStats(ranked, minCount) {
    const by = {};
    ranked.forEach(function (r) {
      const k = fold(r.restaurant);
      if (!by[k]) by[k] = { restaurant: r.restaurant, cities: {}, burgers: [] };
      by[k].burgers.push(r);
      by[k].cities[baseCity(r.city)] = true;
    });
    return Object.keys(by)
      .map(function (k) {
        const g = by[k];
        const sum = g.burgers.reduce(function (s, b) { return s + b.score; }, 0);
        return {
          restaurant: g.restaurant,
          city: Object.keys(g.cities).join(', '),
          count: g.burgers.length,
          avg: sum / g.burgers.length,
          best: g.burgers[0], // ranked input → first is best
          worst: g.burgers[g.burgers.length - 1],
        };
      })
      .filter(function (s) { return s.count >= (minCount || 1); })
      .sort(function (a, b) { return b.avg - a.avg || b.count - a.count || a.restaurant.localeCompare(b.restaurant); });
  }

  /* ----------------------------------------------------- formula checker */

  function sectionKind(section) {
    if (/must/i.test(section)) return 'must';
    if (/boost|elite/i.test(section)) return 'boost';
    if (/avoid|anti/i.test(section)) return 'avoid';
    return 'info';
  }

  /** "MUST-HAVES (Floor: 8.0+)" → "Must-haves" */
  function sectionTitle(section) {
    const t = String(section || '').replace(/\([^)]*\)/g, '').trim().toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /** Scores written in a row's text, e.g. "Smokehouse 5.5 · Curd 5.6" → [5.5, 5.6]. */
  function scoresIn(text) {
    const out = [];
    const re = /(^|[^\d.])(\d{1,2}\.\d)(?![\d])/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const v = parseFloat(m[2]);
      if (v >= 0 && v <= 10) out.push(v);
    }
    return out;
  }

  /**
   * Turns the Perfect Burger Formula tab into checklist groups.
   * - Must-haves: the floor in the section name (8.0) is what they unlock.
   * - Boosters: the ceiling in the section name (8.4) is what they unlock.
   * - Avoid rows: their ceiling is the highest score written in that row —
   *   i.e. the best you've ever rated a burger with that flaw.
   */
  function parseFormula(rows) {
    const groups = [];
    const bySection = {};
    (rows || []).forEach(function (r, i) {
      const section = String(r.Section || '').trim();
      const element = String(r.Element || '').trim();
      if (!section || !element) return;
      if (!bySection[section]) {
        const th = section.match(/(\d+(?:\.\d+)?)\s*\+/);
        bySection[section] = {
          section: section,
          title: sectionTitle(section),
          kind: sectionKind(section),
          threshold: th ? parseFloat(th[1]) : null,
          items: [],
        };
        groups.push(bySection[section]);
      }
      const g = bySection[section];
      const evidence = scoresIn((r.Spec || '') + ' ' + (r.Detail || ''));
      g.items.push({
        id: 'f' + i,
        element: element,
        spec: String(r.Spec || '').trim(),
        detail: String(r.Detail || '').trim(),
        cap: g.kind === 'avoid' && evidence.length ? Math.max.apply(null, evidence) : null,
      });
    });
    const must = groups.find(function (g) { return g.kind === 'must'; });
    const boost = groups.find(function (g) { return g.kind === 'boost'; });
    return {
      groups: groups,
      thresholds: {
        great: must && must.threshold != null ? must.threshold : DEFAULT_THRESHOLDS.great,
        elite: boost && boost.threshold != null ? boost.threshold : DEFAULT_THRESHOLDS.elite,
        good: RECOMMEND_LINE,
      },
    };
  }

  /** Boosters needed (with every must-have) to call a burger an elite contender. */
  const ELITE_BOOSTERS = 2;

  /**
   * Predicts a score band from what the menu says. Deliberately a ceiling
   * model: it says how high a burger CAN go given your own formula, because
   * execution is the one thing a menu can't tell you.
   */
  function predict(formula, checked) {
    const on = function (id) { return !!(checked && checked[id]); };
    const t = formula.thresholds;
    const musts = [], boosts = [], avoids = [];
    formula.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        if (g.kind === 'must') musts.push(it);
        else if (g.kind === 'boost') boosts.push(it);
        else if (g.kind === 'avoid') avoids.push(it);
      });
    });
    const anyChecked = musts.concat(boosts, avoids).some(function (it) { return on(it.id); });
    if (!anyChecked) return { empty: true };

    const missing = musts.filter(function (it) { return !on(it.id); });
    const boostCount = boosts.filter(function (it) { return on(it.id); }).length;
    const reasons = [];

    let low, high;
    if (missing.length === 0 && boostCount >= ELITE_BOOSTERS) {
      low = t.elite; high = 10;
      reasons.push({ good: true, text: 'Every must-have plus ' + boostCount + ' boosters: built like your top burgers' });
    } else if (missing.length === 0) {
      low = t.great; high = round1(t.elite - 0.1);
      reasons.push({ good: true, text: 'Every must-have' + (boostCount ? ', ' + boostCount + ' booster' : '') + '; ' + ELITE_BOOSTERS + ' boosters are what push past ' + t.elite.toFixed(1) });
    } else {
      low = null; high = round1(t.great - 0.1);
      reasons.push({ good: false, text: 'Missing ' + list(missing.map(function (m) { return m.element.toLowerCase(); })) + ': every ' + t.great.toFixed(1) + '+ burger had ' + (missing.length > 1 ? 'these' : 'it') });
    }

    avoids.filter(function (a) { return on(a.id); }).forEach(function (a) {
      if (a.cap != null) {
        if (a.cap < high) high = a.cap;
        reasons.push({ good: false, text: a.element + ': your best with this is ' + a.cap.toFixed(1) });
      } else {
        reasons.push({ good: false, text: a.element + ' (no score on record to cap it)' });
      }
    });
    // A red flag can pull the ceiling under the band's floor: drop to the
    // highest floor the burger still qualifies for, or show only the ceiling.
    if (low != null && low > high) low = (missing.length === 0 && t.great <= high) ? t.great : null;

    const verdict = high >= t.elite ? 'elite' : high >= t.great ? 'great' : high >= t.good ? 'good' : 'skip';
    return {
      empty: false,
      low: low,
      high: high,
      verdict: verdict,
      label: { elite: 'Elite contender', great: 'Order it', good: 'Fine, not special', skip: 'Skip it' }[verdict],
      band: low == null ? 'up to ' + high.toFixed(1) : high >= 10 ? low.toFixed(1) + '+' : low.toFixed(1) + '–' + high.toFixed(1),
      // What's holding it back reads first.
      reasons: reasons.filter(function (r) { return !r.good; }).concat(reasons.filter(function (r) { return r.good; })),
    };
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  function list(words) {
    if (words.length <= 1) return words.join('');
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }

  /* --------------------------------------------------------- tutorial */

  /**
   * Groups the tutorial tab by section. `names` (the ranked burgers) lets
   * headings keep proper nouns like "Cincy Stack" when the sheet is all caps.
   */
  function groupTutorial(rows, names) {
    const phrases = properPhrases(names);
    const out = [];
    const by = {};
    (rows || []).forEach(function (r) {
      const s = String(r.Section || '').trim();
      if (!s) return;
      if (!by[s]) { by[s] = { section: s, title: tidySection(s, phrases), items: [] }; out.push(by[s]); }
      by[s].items.push({ element: String(r.Element || '').trim(), spec: String(r.Spec || '').trim(), detail: String(r.Detail || '').trim() });
    });
    return out;
  }

  /** Two-plus-word names from the list ("Cincy Stack", "Red Robin"), longest first. */
  function properPhrases(rows) {
    const seen = {};
    (rows || []).forEach(function (r) {
      [String(r.burger || '').replace(/\s+burger$/i, ''), String(r.restaurant || '')].forEach(function (n) {
        n = n.replace(/\([^)]*\)/g, '').trim();
        if (n.split(/\s+/).length >= 2 && /^[A-Z]/.test(n)) seen[n.toLowerCase()] = n;
      });
    });
    return Object.keys(seen).sort(function (a, b) { return b.length - a.length; }).map(function (k) { return seen[k]; });
  }

  /**
   * "9. SAUCE A — BLACK PEPPER AIOLI (CINCY STACK-INSPIRED)"
   *   → { num: "9", text: "Sauce A: black pepper aioli (Cincy Stack-inspired)" }
   */
  function tidySection(s, phrases) {
    const m = String(s).match(/^\s*([0-9]+[A-Z]?)\.\s*(.*)$/);
    const num = m ? m[1] : '';
    const raw = (m ? m[2] : String(s)).replace(/\s+—\s+/g, ': ');
    // Mixed-case headings were written on purpose: leave them alone.
    if (raw !== raw.toUpperCase()) return { num: num, text: raw };
    let text = raw.toLowerCase();
    // A lone letter right before a colon is a label ("Sauce A:"), not the word "a".
    text = text.replace(/\b([a-z])(?=:)/g, function (c) { return c.toUpperCase(); });
    (phrases || []).forEach(function (p) {
      const re = new RegExp('\\b' + p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      text = text.replace(re, p);
    });
    text = text.charAt(0).toUpperCase() + text.slice(1);
    return { num: num, text: text };
  }

  return {
    RECOMMEND_LINE: RECOMMEND_LINE,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    TIER_TEXT: TIER_TEXT,
    fold: fold, key: key, baseCity: baseCity,
    rank: rank, previewRank: previewRank, tierOf: tierOf,
    search: search, cities: cities, restaurantStats: restaurantStats,
    parseFormula: parseFormula, predict: predict, scoresIn: scoresIn,
    groupTutorial: groupTutorial, tidySection: tidySection,
  };
});
