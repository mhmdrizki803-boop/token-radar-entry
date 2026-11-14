/*
  Token Radar, as a single plain browser script: no framework, no libraries, no network.

  It reads window.RADAR, the object main.ts serialises into data.js beside this page, and
  builds the whole board from it: a masthead carrying the snapshot date and the model
  version, the summary counts that say how many protocols were scored and how many were set
  aside, a search box and a category filter over the rows, a sortable table of the ranked
  pre-token protocols, a second table for the protocols that already trade, a short
  statement of the pricing model, and a side drawer that opens on any row to show how that
  row was priced together with a plain farm plan for it.

  The only arithmetic performed here is the model itself, recomputed from the row's own
  snapshot figures, so the page can show that its maths and board.json agree.
*/
(function () {
  'use strict';

  const radar = window.RADAR;
  const mount = document.getElementById('board');
  if (!radar || !mount) return;

  const model = radar.model;

  /* ── what the reader has chosen so far ───────────────────────────────── */

  const view = {
    query: '',
    category: 'all',
    tab: 'pre-token',        // 'pre-token' ranks; 'live' lists what already trades
    sort: 'implied',
    descending: true,
    selected: null           // slug of the row whose drawer is open
  };

  /* ── reading numbers back out ────────────────────────────────────────── */

  const wholeDollars = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function money(value) {
    if (!isNumber(value)) return 'n/a';
    const size = Math.abs(value);
    if (size >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (size >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
    if (size >= 1e3) return '$' + Math.round(value / 1e3) + 'K';
    return wholeDollars.format(value);
  }

  function percent(value) {
    if (!isNumber(value)) return 'n/a';
    return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  }

  function ageText(days) {
    if (!isNumber(days)) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /* ── the model, restated so the page can check board.json ────────────── */

  /*
    The fitted power law, in the same order of operations as lib/model.ts:
      fit      = scale x TVL^elasticity
      category = the fitted multiplier for the row's category (1 when the fit never saw it)
      seasoning= seasoning_floor + min(age, seasoning_days) / seasoning_days x seasoning_range
      momentum = 1 + clamp(change_7d, momentum_floor, momentum_cap) / 100 x momentum_weight
    Every constant comes out of radar.model, so this is the model the board was scored with and not a
    restatement of it: if the two ever disagree the drawer says so.
  */
  function reprice(row) {
    const tvl = isNumber(row.tvl_usd) && row.tvl_usd > 0 ? row.tvl_usd : 1;
    const fit = model.scale * Math.pow(tvl, model.elasticity);

    const rawGrowth = isNumber(row.change_7d) ? row.change_7d : 0;
    const growth = Math.min(model.momentum_cap, Math.max(model.momentum_floor, rawGrowth));
    const growthStep = 1 + (growth / 100) * model.momentum_weight;

    const age = isNumber(row.age_days) ? row.age_days : model.unknown_age_days;
    const held = Math.min(Math.max(age, 0), model.seasoning_days);
    const seasoning = model.seasoning_floor + (held / model.seasoning_days) * model.seasoning_range;

    const category = isNumber(row.category_multiplier) ? row.category_multiplier : 1;

    return Math.max(1, Math.round(fit * category * seasoning * growthStep));
  }

  /* ── the farm plan, derived the same way for every row ───────────────── */

  function firstChain(row) {
    return row.chains && row.chains.length ? row.chains[0] : 'its main chain';
  }

  function chainList(row, limit) {
    const chains = row.chains || [];
    if (!chains.length) return 'an unnamed chain';
    return (limit > 0 ? chains.slice(0, limit) : chains).join(', ');
  }

  function whereItRuns(row, limit) {
    return (row.category || 'Other') + ' on ' + chainList(row, limit);
  }

  function capitalFor(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    return 50;
  }

  function holdFor(days) {
    if (!isNumber(days)) return 30;
    if (days < 180) return 60;
    if (days < 365) return 45;
    return 30;
  }

  // Category decides the verb; nothing else does, and no protocol is named here.
  const PLAN_RULES = [
    { test: /lend|cdp|collateral/, say: (p, cash, chain) =>
        'Supply $' + cash + ' of USDC to ' + p.name + ' on ' + chain + ' and keep the position open.' },
    { test: /dex|yield|leveraged farm/, say: (p, cash, chain) =>
        'Provide $' + cash + ' of liquidity to ' + p.name + "'s main pool on " + chain + ' and keep the position open.' },
    { test: /bridge/, say: (p, cash, chain) =>
        'Bridge $' + cash + ' of USDC to ' + chain + ' through ' + p.name + ' and use the bridged funds in its app.' },
    { test: /staking|restak/, say: (p, cash) =>
        "Stake $" + cash + " of the chain's staking asset through " + p.name + ' and keep the receipt.' },
    { test: /perpetual|derivative/, say: (p, cash) =>
        'Deposit $' + cash + ' of USDC as margin on ' + p.name + ' and open one small hedge.' },
    { test: /prediction/, say: (p, cash) =>
        'Fund $' + cash + ' and place one market position on ' + p.name + '.' },
    { test: /curator|allocator/, say: (p, cash, chain) =>
        'Deposit $' + cash + ' into a ' + p.name + ' vault on ' + chain + ' and keep the shares.' },
    { test: /stable/, say: (p, cash, chain) =>
        'Mint or deposit $' + cash + ' of the stable asset through ' + p.name + ' on ' + chain + '.' },
    { test: /rwa/, say: (p, cash, chain) =>
        "Mint $" + cash + " of the protocol's yield asset on " + chain + ' and hold it.' },
    { test: /insurance/, say: (p, cash, chain) =>
        'Buy $' + cash + ' of cover from ' + p.name + ' on ' + chain + ' and keep the policy.' }
  ];

  function openingMove(row, cash, chain) {
    const category = (row.category || '').toLowerCase();
    const rule = PLAN_RULES.find(function (candidate) { return candidate.test.test(category); });
    if (rule) return rule.say(row, cash, chain);
    return 'Deposit $' + cash + ' of USDC into ' + row.name + ' on ' + chain + ' and keep the position open.';
  }

  function stepLine(step) {
    let text = step.body + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (text.length > 600) text = text.slice(0, 596) + '...';
    if (text.length < 20) text = text + " Hold the position and check the protocol's own page.";
    return text;
  }

  function farmPlan(row) {
    const chain = firstChain(row);
    const cash = capitalFor(row.tvl_usd);
    const hold = holdFor(row.age_days);
    const gas = cash >= 150 ? 8 : 4;

    return [
      { body: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { body: openingMove(row, cash, chain),
        cost: '$' + cash + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { body: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
        cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { body: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
        cost: 'the $' + cash + ' stays in the position', time: hold + ' days' },
      { body: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
        cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { body: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
        cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepLine);
  }

  /* ── building elements without a template engine ─────────────────────── */

  function fill(parent, children) {
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) fill(parent, child);
      else if (typeof child === 'string' || typeof child === 'number') parent.appendChild(document.createTextNode(String(child)));
      else parent.appendChild(child);
    });
  }

  function node(tag, props) {
    const element = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        const value = props[key];
        if (value === null || value === undefined) return;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key === 'on') {
          Object.keys(value).forEach(function (eventName) {
            element.addEventListener(eventName, value[eventName]);
          });
        } else element.setAttribute(key, value === true ? '' : String(value));
      });
    }
    fill(element, Array.prototype.slice.call(arguments, 2));
    return element;
  }

  /* ── filtering and ordering ──────────────────────────────────────────── */

  const SORT_KEYS = {
    name: function (row) { return row.name.toLowerCase(); },
    tvl: function (row) { return row.tvl_usd; },
    growth: function (row) { return isNumber(row.change_7d) ? row.change_7d : -Infinity; },
    age: function (row) { return isNumber(row.age_days) ? row.age_days : Infinity; },
    implied: function (row) { return row.implied_value_usd; }
  };

  function matching() {
    const needle = view.query.trim().toLowerCase();
    return radar.rows.filter(function (row) {
      if (view.category !== 'all' && row.category !== view.category) return false;
      if (!needle) return true;
      const haystack = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }

  function ordered(rows) {
    const pick = SORT_KEYS[view.sort] || SORT_KEYS.implied;
    const direction = view.descending ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      const left = pick(a);
      const right = pick(b);
      if (left < right) return -direction;
      if (left > right) return direction;
      if (a.slug === b.slug) return 0;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  /* ── the top of the page ─────────────────────────────────────────────── */

  function masthead() {
    return node('header', { class: 'top' },
      node('div', { class: 'brand' },
        node('span', { class: 'mark' }),
        node('span', { class: 'brand-name', text: 'Token Radar' })),
      node('div', { class: 'top-meta' },
        node('span', { text: 'Snapshot ' + radar.as_of }),
        node('span', { text: 'DefiLlama protocol index' }),
        node('span', { text: radar.model_version + ' model' })));
  }

  function fact(label, value) {
    return node('div', { class: 'fact' },
      node('span', { text: label }),
      node('b', { text: value }));
  }

  function summary() {
    const floorMillions = Math.round(radar.floor_usd / 1e6);
    return node('section', { class: 'lede' },
      node('div', null,
        node('h1', { text: radar.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        node('p', { text: 'The watchlist is the floor: every protocol with at least $' + floorMillions + 'M of TVL and no token on record. The early radar adds ' + radar.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })),
      node('div', { class: 'facts' },
        fact('Watchlist covered', radar.watchlist_size + ' / ' + radar.watchlist_size),
        fact('Pre-token rows scored', String(radar.board_size)),
        fact('Early rows below the floor', String(radar.early_size)),
        fact('Live-token protocols set aside', String(radar.live_size))));
  }

  /* ── the filter bar ──────────────────────────────────────────────────── */

  const categories = Array.from(new Set(radar.rows.map(function (row) {
    return row.category || 'Other';
  }))).sort();

  const tabButtons = {};

  function tabButton(name, label) {
    tabButtons[name] = node('button', {
      type: 'button',
      text: label,
      on: { click: function () { view.tab = name; paint(); } }
    });
    return tabButtons[name];
  }

  // The two controls are built once and then kept in step with the view, so clearing the
  // filters from inside the empty state also empties the box the reader typed in.
  const searchInput = node('input', {
    type: 'search', id: 'q', placeholder: 'Search name, category or chain',
    value: view.query, 'aria-label': 'Search the board'
  });
  searchInput.addEventListener('input', function () {
    view.query = searchInput.value;
    syncLocation();
    paint();
  });

  const categorySelect = node('select', { id: 'category', 'aria-label': 'Filter by category' },
    node('option', { value: 'all', text: 'All categories' }),
    categories.map(function (name) {
      return node('option', { value: name, text: name });
    }));
  categorySelect.addEventListener('change', function () {
    view.category = categorySelect.value;
    syncLocation();
    paint();
  });

  function alignControls() {
    if (searchInput.value !== view.query) searchInput.value = view.query;
    if (categorySelect.value !== view.category) categorySelect.value = view.category;
  }

  const countLabel = node('span', { class: 'count' });

  function filterBar() {
    return node('div', { class: 'controls' },
      node('div', { class: 'field' },
        node('label', { for: 'q', text: 'Search' }),
        searchInput),
      node('div', { class: 'field' },
        node('label', { for: 'category', text: 'Category' }),
        categorySelect),
      node('div', { class: 'field' },
        node('span', { class: 'sub', text: 'Token status' }),
        node('div', { class: 'tabs' },
          tabButton('pre-token', 'Pre-token'),
          tabButton('live', 'Live token'))),
      countLabel);
  }

  /* ── the ranked table ────────────────────────────────────────────────── */

  function toggleSort(key) {
    if (view.sort === key) view.descending = !view.descending;
    else { view.sort = key; view.descending = true; }
    paint();
  }

  function sortableHeader(label, key) {
    return node('th', { scope: 'col' },
      node('button', {
        type: 'button',
        on: { click: function () { toggleSort(key); } }
      },
        label,
        view.sort === key
          ? node('span', { 'aria-hidden': 'true', text: view.descending ? ' v' : ' ^' })
          : null));
  }

  function boardRow(row, ceiling) {
    const hasGrowth = isNumber(row.change_7d);
    const share = Math.max(3, Math.round((row.implied_value_usd / ceiling) * 100));

    return node('tr', {
      'data-selected': view.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      on: {
        click: function () { chooseRow(row.slug); },
        keydown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            chooseRow(row.slug);
          }
        }
      }
    },
      node('td', { class: 'num', text: String(row.rank) }),
      node('td', null,
        node('div', { class: 'name' },
          node('b', { text: row.name }),
          node('span', { class: 'sub', text: whereItRuns(row, 2) }))),
      node('td', { class: 'num', text: money(row.tvl_usd) }),
      node('td', { class: 'num ' + (hasGrowth ? (row.change_7d >= 0 ? 'pos' : 'neg') : ''), text: percent(row.change_7d) }),
      node('td', { class: 'num', text: ageText(row.age_days) }),
      node('td', null,
        node('div', { class: 'implied' },
          node('div', { class: 'bar', 'aria-hidden': 'true' },
            node('i', { style: 'width:' + share + '%' })),
          node('span', { class: 'num', text: money(row.implied_value_usd) }))),
      node('td', null, node('span', { class: 'status', text: 'no token' })));
  }

  function emptyState() {
    return node('div', { class: 'panel' },
      node('div', { class: 'empty' },
        node('h2', { text: 'No protocol matches that filter' }),
        node('p', { text: 'Clear the search or pick another category to see the board again.' }),
        node('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          on: {
            click: function () {
              view.query = '';
              view.category = 'all';
              syncLocation();
              paint();
            }
          }
        })));
  }

  function boardPanel() {
    const listed = ordered(matching());
    if (listed.length === 0) return emptyState();

    const ceiling = listed[0].implied_value_usd || 1;
    const body = node('tbody', null, listed.map(function (row) {
      return boardRow(row, ceiling);
    }));

    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          node('thead', null,
            node('tr', null,
              sortableHeader('Rank', 'implied'),
              sortableHeader('Protocol', 'name'),
              sortableHeader('TVL', 'tvl'),
              sortableHeader('7d', 'growth'),
              sortableHeader('Age', 'age'),
              sortableHeader('Implied value', 'implied'),
              node('th', { scope: 'col', text: 'Token' }))),
          body)));
  }

  /* ── the table of protocols that already trade ───────────────────────── */

  function liveRow(row) {
    const hasGrowth = isNumber(row.change_7d);
    return node('tr', null,
      node('td', { class: 'num', text: 'live' }),
      node('td', null,
        node('div', { class: 'name' },
          node('b', { text: row.name }),
          node('span', { class: 'sub', text: whereItRuns(row, 2) }))),
      node('td', { class: 'num', text: money(row.tvl_usd) }),
      node('td', { class: 'num ' + (hasGrowth && row.change_7d >= 0 ? 'pos' : 'neg'), text: percent(row.change_7d) }),
      node('td', { class: 'num', text: money(row.mcap_usd) }),
      node('td', null, node('span', { class: 'status', text: 'already trades' })));
  }

  function livePanel() {
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          node('thead', null,
            node('tr', null,
              node('th', { scope: 'col', text: 'Status' }),
              node('th', { scope: 'col', text: 'Protocol' }),
              node('th', { scope: 'col', text: 'TVL' }),
              node('th', { scope: 'col', text: '7d' }),
              node('th', { scope: 'col', text: 'Market cap' }),
              node('th', { scope: 'col', text: 'Token' }))),
          node('tbody', null, radar.live.map(liveRow)))));
  }

  /* ── the statement of the model ──────────────────────────────────────── */

  function modelPanel() {
    const m = model;
    const fitted = Object.keys(m.category_factors || {}).map(function (name) {
      return name + ' x' + m.category_factors[name];
    });

    return node('section', { class: 'panel model' },
      node('h2', { text: 'How implied value is computed' }),
      node('p', { class: 'sub', text: 'The value is a power law fitted on the ' + m.comparables + ' protocols in this snapshot that already carry both a TVL and a market cap, by least squares in log-log space. Elasticity ' + m.elasticity + ' means a 1% rise in TVL is worth about ' + m.elasticity + '% of market cap: the market is sublinear in TVL, which is what a market that also prices users, narrative and float looks like. ' + m.comparables_excluded + ' protocols carry both figures and are set aside, because their TVL is somebody else\'s asset parked in a wrapper: exchanges, bridges and liquid-staking and restaking receipts.' }),
      node('div', { class: 'formula', text: radar.formula }),
      node('p', { class: 'sub', text: 'How well it fits, stated plainly: TVL explains ' + Math.round(m.r_squared * 100) + '% of the spread of market cap in log space (R-squared), the standard deviation of the log residual is ' + m.residual_sigma + ' (a typical miss of a factor of ' + Math.exp(m.residual_sigma).toFixed(1) + '), and ' + Math.round(m.within_factor_3 * 100) + '% of the comparables land within a factor of 3 of the curve. A weak fit is the honest result: TVL is real and it is not the whole business.' }),
      node('p', { class: 'sub', text: 'Category is fitted, not picked: each multiplier is the median residual of that category\'s comparables, shrunk toward 1 by a ' + m.category_prior + '-comparables prior and clamped to ' + m.category_floor + ' to ' + m.category_cap + ', so one lucky protocol cannot own a category. ' + (fitted.length ? fitted.join(', ') + '.' : '') }),
      node('p', { class: 'sub', text: 'Seasoning runs ' + m.seasoning_floor + ' to ' + (m.seasoning_floor + m.seasoning_range) + ' across ' + m.seasoning_days + ' days with no token, because a protocol that has held TVL for years has shown it can hold TVL; an unlisted age uses ' + m.unknown_age_days + ' days. Momentum is ' + m.momentum_weight + ' of the seven-day change, pinned inside ' + m.momentum_floor + ' to ' + m.momentum_cap + ' per cent, so one week moves a value by at most about ' + Math.round(Math.abs(m.momentum_weight * (m.momentum_cap > 0 ? m.momentum_cap : m.momentum_floor))) + '%: a week is weak evidence and the comparables\' residuals barely correlate with it. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }));
  }

  /* ── the drawer ──────────────────────────────────────────────────────── */

  const drawer = node('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });

  drawer.addEventListener('close', function () {
    view.selected = null;
    syncLocation();
    paint();
  });

  function equationLine(label, value) {
    return node('div', null,
      node('span', { text: label }),
      node('b', { class: 'num', text: value }));
  }

  function planLine(line) {
    const cut = line.indexOf(' Cost: ');
    return node('li', null,
      node('b', { text: cut >= 0 ? line.slice(0, cut) : line }),
      node('span', { class: 'cost', text: cut >= 0 ? line.slice(cut + 1) : '' }));
  }

  // Fills and opens the drawer. It never touches the view: paint() owns that, so the row and the
  // drawer can never disagree about what is selected.
  function showDetail(slug) {
    const row = radar.rows.find(function (candidate) { return candidate.slug === slug; });
    if (!row) return;

    const recomputed = reprice(row);
    drawer.textContent = '';

    drawer.appendChild(node('div', { class: 'detail-head' },
      node('div', null,
        node('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + radar.board_size }),
        node('h2', { id: 'detail-title', text: row.name }),
        node('p', { class: 'sub', text: whereItRuns(row, 0) })),
      node('button', {
        class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close',
        on: { click: function () { drawer.close(); } }
      })));

    drawer.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Implied value' }),
      node('div', { class: 'equation' },
        equationLine('TVL', money(row.tvl_usd)),
        equationLine('Seven-day growth', percent(row.change_7d)),
        equationLine('Age with no token', ageText(row.age_days)),
        equationLine('Category multiplier', String(row.category_multiplier)),
        equationLine('Seasoning multiplier', String(row.maturity_multiplier)),
        equationLine('Momentum multiplier', String(row.growth_multiplier)),
        equationLine('On the fitted curve', money(row.fit_value_usd)),
        equationLine('Implied value', money(row.implied_value_usd))),
      node('p', {
        class: 'sub',
        text: 'Model ' + radar.model_version + ': the same function scores every protocol. The page recomputes this row as '
          + money(recomputed)
          + (recomputed === row.implied_value_usd
            ? ', the same number board.json carries.'
            : ', which differs from the board: the data would be stale.')
          + ' This is an estimate, not a price.'
      })));

    drawer.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Farm plan' }),
      node('ol', { class: 'steps' }, farmPlan(row).map(planLine))));

    if (typeof drawer.showModal === 'function') {
      if (!drawer.open) drawer.showModal();
    } else {
      drawer.setAttribute('open', '');
    }
  }

  // Selecting a row: remember it, put it in the address, redraw (the redraw marks the row and
  // then hands off to showDetail through paint()).
  function chooseRow(slug) {
    view.selected = slug;
    syncLocation();
    paint();
  }

  /* ── the address bar carries the reader's filters ────────────────────── */

  function readLocation() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    if (params.get('q')) view.query = params.get('q');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('p')) view.selected = params.get('p');
  }

  function syncLocation() {
    const params = new URLSearchParams();
    if (view.query) params.set('q', view.query);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    window.history.replaceState(
      null, '',
      next ? '#' + next : window.location.pathname + window.location.search
    );
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */

  const resultsHost = node('div');
  const modelHost = node('div');

  const page = node('div', { class: 'shell' },
    masthead(),
    summary(),
    filterBar(),
    resultsHost,
    modelHost);

  function paint() {
    alignControls();
    resultsHost.textContent = '';
    resultsHost.appendChild(view.tab === 'pre-token' ? boardPanel() : livePanel());

    modelHost.textContent = '';
    if (view.tab === 'pre-token') modelHost.appendChild(modelPanel());

    countLabel.textContent = view.tab === 'pre-token'
      ? matching().length + ' rows shown'
      : radar.live.length + ' live-token protocols';

    Object.keys(tabButtons).forEach(function (name) {
      tabButtons[name].setAttribute('aria-pressed', view.tab === name ? 'true' : 'false');
    });

    if (view.selected) showDetail(view.selected);
  }

  readLocation();
  mount.appendChild(page);
  mount.setAttribute('aria-busy', 'false');
  if (!drawer.isConnected) mount.appendChild(drawer);
  paint();

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && drawer.open) drawer.close();
  });
})();
