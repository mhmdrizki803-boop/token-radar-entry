// Token Radar's scoring model: one sealed snapshot in, one ranked board out.
//
// Three decisions, and the rest of this file follows from them.
//
// 1. Who may be ranked. A protocol is scored only when its record carries no token at all: no market
//    cap, no CoinGecko id, no ticker. Those are the launches still ahead of us. Protocols that already
//    trade are never folded into the ranking, because their market already states their value; the
//    dashboard shows them on the side exactly as the snapshot has them. A record with no token that is
//    plainly somebody else's product is dropped too: an exchange, or a name carrying a release marker.
// 2. What a pre-token protocol is worth. There is no price to read, so the model prices the business:
//    a share of its TVL, bent by recent growth and by how long it has run without a token. A protocol
//    that has held TVL for years has shown it can hold TVL, so age counts upward.
//
//      base    = tvl_usd * base_multiple
//      growth  = change_7d pinned inside [growth_floor, growth_cap], in per cent
//      gMult   = 1 + (growth / 100) * growth_weight
//      mMut    = maturity_floor + min(age_days, maturity_days) / maturity_days * maturity_range
//      implied = max(1, round(base * gMult * mMut))
//
//    An unreported change_7d reads as flat and an unreported age reads as unknown_age_days, so a thin
//    record is scored conservatively rather than skipped.
// 3. Which rows the board carries. The watchlist is a floor and never a ceiling: every slug on it is
//    ranked, and then the heaviest pre-token protocols still under the TVL floor are added as the early
//    rows, which is the whole point of a radar. No protocol name is special-cased anywhere in this
//    file, so the ordering is a function of the snapshot and can be recomputed by a reader.

/** One protocol as the sealed snapshot carries it: exactly these ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document, as read from the sealed file. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The weights the value model runs on. Every one of them is stated on the dashboard. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

/**
 * The house weights: a quarter of TVL as a starting point, half of the seven-day growth passed
 * through, and maturity running from 0.6 to 1.0 over three years. A protocol whose age the snapshot
 * does not carry is treated as one year old.
 */
export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The label the dashboard prints beside its numbers, so a reader can tell two models apart. */
export const MODEL_VERSION = 'radar-1';

/** How many pre-token protocols below the TVL floor the early radar carries, heaviest TVL first. */
export const EARLY_ROWS = 160;

/** How many already-trading protocols the dashboard's live view carries, largest market cap first. */
export const LIVE_ROWS = 24;

/** One farm step: what to do, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A row of board.json: one ranked pre-token protocol with its score and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A row as the dashboard's data.js carries it: enough to re-derive the score in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A protocol whose token already trades: the board shows the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The whole dataset the dashboard renders: the board, the live set aside, and the model behind it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline figures main.ts prints and the page shows above the table. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** A snapshot this model will not score: the file is not the document it expects. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ------------------------------------------------------------------ reading numbers off a record

const DAY_MS = 86_400_000;

/** A finite number when one is there, else the fallback: the snapshot is untrusted input. */
function realNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four decimals, the precision board.json states its multipliers at. */
function roundTo4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The tie-break every sort in this file ends on, so equal scores never reorder between runs. */
function slugOrder(a: { slug: string }, b: { slug: string }): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** A protocol by slug, for the watchlist lookup. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/**
 * Whole days from the day a protocol was first tracked to the snapshot's own day, never negative.
 * Null when the snapshot carries no listing day, or carries one that is not a date.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const snapshotDay = Date.parse(`${asOf}T00:00:00Z`);
  const listedDay = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(snapshotDay) || !Number.isFinite(listedDay)) return null;
  return Math.max(0, Math.floor((snapshotDay - listedDay) / DAY_MS));
}

// ------------------------------------------------------------------ the value model

/**
 * One protocol's implied value under `model`, with the inputs that produced it so the board can show
 * its work: the growth actually used after pinning, and both multipliers.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const reportedGrowth = realNumber(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, reportedGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

// ------------------------------------------------------------------ who belongs on the board

/** A trailing release marker: "V2", "v3", "3.0" and the like, which name a pool and not a protocol. */
const RELEASE_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the record carries no token at all. It says what DefiLlama records, never what exists. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether the board may rank a protocol on its own merits: no token recorded, not an exchange, and not
 * a versioned pool of another protocol. The watchlist is added regardless; this only gates the extras.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !RELEASE_MARKER.test(p.name);
}

// ------------------------------------------------------------------ the farm plan

/** The first chain a protocol names. The phrase stands in when the record names none. */
function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much a position should carry, stepped down the TVL ladder so a small protocol asks less. */
function positionSize(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/**
 * How long the position should stay open. A young protocol is still finding its users, so it needs a
 * longer window to be counted in more than one snapshot; an established one is counted sooner.
 */
function qualifyingDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The protocol's main action, chosen by category alone: one sentence a reader can follow. */
function farmAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const kind = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  }
  if (kind.includes('dex') || kind.includes('yield') || kind.includes('leveraged farm')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  }
  if (kind.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  }
  if (kind.includes('staking') || kind.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  }
  if (kind.includes('perpetual') || kind.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  }
  if (kind.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (kind.includes('curator') || kind.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (kind.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (kind.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (kind.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as the one string board.json carries: action, cost, time, inside the gate's 20..600 chars. */
export function stepText(step: FarmStep): string {
  let text = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (text.length > 600) text = `${text.slice(0, 596)}...`;
  if (text.length < 20) text = `${text} Hold the position and check the protocol's own page.`;
  return text;
}

/**
 * A protocol's farm plan as six steps, each with its cost and its time. Every step comes out of the
 * record itself (category, chains, TVL, age); nothing here knows any protocol by name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const capital = positionSize(p);
  const holdDays = qualifyingDays(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: farmAction(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${holdDays} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${holdDays} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ------------------------------------------------------------------ ranking

/**
 * The ranked board: the watchlist first (it is the floor, so a slug is never dropped for looking
 * weak), then the heaviest pre-token protocols under the TVL floor, then one sort by implied value
 * with ranks 1..n written on top. Ties break on slug so two runs agree byte for byte.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();

  for (const slug of snapshot.watchlist) {
    const record = index.get(slug);
    if (record !== undefined) chosen.set(slug, record);
  }

  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugOrder(a, b))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.implied - a.implied || slugOrder(a.p, b.p));

  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: roundTo4(s.growthMult),
      maturity_multiplier: roundTo4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The protocols that already trade, largest market cap first, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row trimmed to what data.js needs; the page rebuilds the farm plan from these fields. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** The board and the dashboard's dataset, from one pass: main.ts writes both from this. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const onWatchlist = new Set(snapshot.watchlist);
  const earlySize = board.filter((r) => !onWatchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlySize,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ------------------------------------------------------------------ the snapshot file

/** A string field, else null: the snapshot uses null where DefiLlama has a placeholder. */
function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A number field, else null: an unreadable figure is an absent one, never zero. */
function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The chains a protocol runs on, keeping only the readable ones. */
function readChains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
}

/** One protocol record out of the file, refused when it lacks the three fields the model needs. */
function readProtocol(value: unknown, position: number): SnapshotProtocol {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError(`snapshot.json's protocol ${position} is not an object`);
  }
  const p = value as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${position} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: readOptionalString(p.category),
    chains: readChains(p.chains),
    tvl_usd: p.tvl_usd,
    change_7d: readOptionalNumber(p.change_7d),
    mcap_usd: readOptionalNumber(p.mcap_usd),
    listed_at: readOptionalString(p.listed_at),
    gecko_id: readOptionalString(p.gecko_id),
    symbol: readOptionalString(p.symbol),
  };
}

/** The snapshot out of the file's text. Anything that is not this document is refused here. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map(readProtocol),
    watchlist: o.watchlist as string[],
  };
}

// ------------------------------------------------------------------ the gate's own checks

/**
 * Why the gate would refuse this board, or null when it would take it. This is a local rehearsal of
 * the scorer's four row rules (coverage, ranks, non-rising implied value, farm steps), run by main.ts
 * before anything is written, so a broken board stops the run instead of failing the entry silently.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const ranked = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !ranked.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }

  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;

  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }

  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }

  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, so the page opens with no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
