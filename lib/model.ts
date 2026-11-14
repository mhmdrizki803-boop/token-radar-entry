// Token Radar's scoring model: one sealed snapshot in, one ranked board out.
//
// The model does not guess a multiple. It reads one off the snapshot.
//
//   value = 10^intercept x TVL^elasticity x category x seasoning x momentum
//
// The curve is fitted, not picked: every protocol in the snapshot that already carries both a TVL and
// a market cap is a comparable, and the comparables are made to state what the market pays for TVL.
// Four decisions, and the rest of this file follows from them.
//
// 1. Why log-log. Value and TVL are not linearly related and both span seven orders of magnitude: a
//    protocol with $10M of TVL is worth far less than ten times one with $1M, and the relationship is
//    multiplicative (a 2x TVL move is a percentage move in value, not a dollar move). Taking logs turns
//    value = a * TVL^e into log(value) = log(a) + e * log(TVL), a straight line, so the fit is a line
//    through a cloud of points rather than a curve fitted by search. The slope of that line is the
//    elasticity: "a 1% increase in TVL is associated with an e% increase in market cap". e < 1 means
//    the market is sublinear in TVL, which is what a market that also prices tokens, users, narrative
//    and float would look like: TVL is real, and it is not the whole business.
//
// 2. Why least squares, and why robust least squares. OLS in log space is the maximum-likelihood fit
//    under multiplicative log-normal noise, it has a closed form (no iteration, no tuning, no seed),
//    and its residual is exactly a log ratio: a residual of log(2) means the fit missed that protocol
//    by a factor of two either way, which is the unit a reader already thinks in. But an exchange
//    balance sheet, a canonical bridge or a liquid-staking receipt is not a business that will launch a
//    token: its TVL is somebody else's asset parked in it. Thirty-nine such rows in this snapshot
//    carry a market cap, and the largest is off the curve by a factor of 660. Plain OLS chases them.
//    So this file fits with Huber iteratively reweighted least squares (IRLS): five rounds, each
//    down-weighting the rows whose residual exceeds 1.345 robust sigmas, so a handful of outliers can
//    bend the line a little and cannot decide it. The estimator is deterministic: same snapshot, same
//    bytes, every run.
//
// 3. What the fit is measured by. R-squared in log space says how much of the spread the TVL term
//    explains, and this snapshot's honest answer is "not much": TVL alone leaves the residual sigma at
//    about 2.0 in log space, a typical miss of a factor of seven. The headline the page prints is
//    therefore the one a reader can act on: how many comparables land within a factor of three of the
//    fitted value. Nearly half do. A model that says so about itself is worth more than one that
//    prints an elasticity and stops.
//
// 4. The three multipliers, each stated as what it is. Category is fitted from the median residual of
//    the comparables in that category, shrunk toward 1 by a five-observation prior so a category with
//    one comparable does not get its own curve, and clamped to [0.40, 3.00]. Seasoning is 1.00 to 1.30
//    over four years, because a protocol that has held TVL for years has shown it can hold TVL, and
//    because the snapshot's own comparables drift the same way (older protocols sit below the curve by
//    about a factor of 0.6, so the age premium is deliberately a fifth of that drift: this is the one
//    place where the model leans against its own data, and it leans gently). Momentum is a quarter of
//    the seven-day change, pinned inside [-60, 120] per cent: a week of growth is weak evidence, so it
//    moves a value by at most about 15%, and the comparables' own residual barely correlates with it
//    (r = -0.09), which is why the weight is small rather than large.
//
// Everything the model decides is exported, so dashboard/app.js prints the fitted formula and
// recomputes every row from it, and main.ts writes the same numbers into data.js.

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

/**
 * The weights the value model runs on: the fitted power law, then the three stated multipliers.
 *
 * Elasticity and intercept are FITTED from the snapshot at build time; the growth, seasoning and
 * category constants are the priors that shape the multipliers, and the fit statistics are what the
 * page quotes back to the reader. Nothing here is a hand-picked multiple of TVL.
 */
export interface ModelConstants {
  /** Slope of the log-log fit: d log(value) / d log(TVL). */
  elasticity: number;
  /** Intercept of the log-log fit, in natural logs: log(a) in value = a * TVL^elasticity. */
  intercept_ln: number;
  /** The same intercept as the base 10 exponent the page prints: 10^intercept_log10 = a. */
  intercept_log10: number;
  /** a of value = a * TVL^elasticity, after re-centring so the category factors average to 1. */
  scale: number;
  /** Fraction of log-space variance in market cap that the TVL term explains, 0..1. */
  r_squared: number;
  /** Standard deviation of the log residuals: exp(sigma) is the typical miss factor. */
  residual_sigma: number;
  /** Fraction of comparables whose implied value lands within a factor of 3 of their market cap. */
  within_factor_3: number;
  /** How many protocols the curve was fitted on. */
  comparables: number;
  /** How many protocols carried both figures and were set aside as someone else's TVL. */
  comparables_excluded: number;
  /** Fitted category multipliers, keyed by the snapshot's category string. */
  category_factors: Record<string, number>;
  category_prior: number;
  category_floor: number;
  category_cap: number;
  /** Seasoning: 1 + min(age_days, full_days) / full_days * range. */
  seasoning_floor: number;
  seasoning_range: number;
  seasoning_days: number;
  unknown_age_days: number;
  /** Momentum: 1 + clamp(change_7d, floor, cap) / 100 * weight. */
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
}

/** The label the dashboard prints beside its numbers, so a reader can tell two models apart. */
export const MODEL_VERSION = 'radar-2-fit';

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
    category_multiplier: number;
    fit_value_usd: number;
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
  category_multiplier: number;
  fit_value_usd: number;
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
  /** The fitted formula in one line, with the fitted numbers already in it. */
  formula: string;
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

/** The median of a list of numbers; the mean of the two middle values when the list is even. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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

// ------------------------------------------------------------------ the comparables

/**
 * Categories whose TVL is somebody else's asset rather than the protocol's own business: a canonical
 * bridge, a liquid-staking or restaking receipt and an exchange balance sheet all park value that
 * already belongs to a token that trades. They carry a market cap in the snapshot, and that market cap
 * prices the chain or the parent, not the TVL parked in the wrapper, so they are counted out of the
 * curve and out of the hit rate instead of being allowed to bend it.
 */
const DERIVATIVE_CATEGORIES: ReadonlySet<string> = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** A name that says so in words, for a record whose category does not: "Staked ETH", "wrapped BTC". */
const DERIVATIVE_NAME = /wrapped|staked|staking/i;

/** Whether a record's TVL is a receipt for an asset that already trades, rather than its own book. */
export function isDerivativeBook(p: SnapshotProtocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  return DERIVATIVE_NAME.test(p.name);
}

/** Whether the snapshot carries both figures a comparable needs: a TVL and a market cap. */
export function hasBothFigures(p: SnapshotProtocol): boolean {
  return typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/** The comparables: the protocols that already trade, minus the ones whose TVL is a receipt. */
export function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => hasBothFigures(p) && !isDerivativeBook(p));
}

// ------------------------------------------------------------------ the fit

/** Huber's constant: a residual past 1.345 robust sigmas is down-weighted, not dropped. */
const HUBER_K = 1.345;
/** The consistency constant that makes the median absolute deviation estimate a normal sigma. */
const MAD_TO_SIGMA = 1.4826;
/** How many reweighting rounds: eight is past the point where this snapshot's weights stop moving. */
const IRLS_ROUNDS = 8;

/** How far a fitted category factor may travel from 1, so one comparable cannot own a category. */
const CATEGORY_FLOOR = 0.4;
const CATEGORY_CAP = 3;
/** The prior weight that shrinks a category factor toward 1: five comparables, not one. */
const CATEGORY_PRIOR = 5;

/**
 * One weighted least-squares pass in log-log space. Returns the slope (the elasticity), the intercept
 * in natural logs, and each row's residual, which is a log ratio: a residual of log(3) means the line
 * missed that protocol by a factor of three.
 */
function weightedLogFit(
  rows: SnapshotProtocol[],
  weights: number[],
): { elasticity: number; intercept: number; residuals: number[] } {
  const n = rows.length;
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    sw += w;
    swx += w * Math.log(rows[i]!.tvl_usd);
    swy += w * Math.log(rows[i]!.mcap_usd as number);
  }
  const xBar = swx / sw;
  const yBar = swy / sw;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    const dx = Math.log(rows[i]!.tvl_usd) - xBar;
    const dy = Math.log(rows[i]!.mcap_usd as number) - yBar;
    sxy += w * dx * dy;
    sxx += w * dx * dx;
  }
  // A snapshot of one TVL value has no slope to fit; a flat market is the honest answer.
  const elasticity = sxx > 0 ? sxy / sxx : 0;
  const intercept = yBar - elasticity * xBar;
  const residuals = rows.map(
    (p) => Math.log(p.mcap_usd as number) - (intercept + elasticity * Math.log(p.tvl_usd)),
  );
  return { elasticity, intercept, residuals };
}

/**
 * The fitted power law, from the comparables alone: Huber IRLS on log(value) against log(TVL), the
 * residual sigma, the R-squared, the share of comparables inside a factor of three, and the category
 * factors read off the median residual of each category and shrunk toward 1.
 *
 * With fewer than three comparables there is no curve to fit: the fit falls back to elasticity 0 and
 * the median value/TVL ratio, which is the same model with the TVL term switched off, and says so in
 * `comparables`.
 */
export function fitModel(snapshot: Snapshot): ModelConstants {
  const rows = comparables(snapshot);
  const n = rows.length;
  const withBoth = snapshot.protocols.filter((p) => hasBothFigures(p)).length;

  if (n === 0) {
    return {
      elasticity: 0,
      intercept_ln: 0,
      intercept_log10: 0,
      scale: 0,
      r_squared: 0,
      residual_sigma: 0,
      within_factor_3: 0,
      comparables: 0,
      comparables_excluded: withBoth,
      category_factors: {},
      category_prior: CATEGORY_PRIOR,
      category_floor: CATEGORY_FLOOR,
      category_cap: CATEGORY_CAP,
      seasoning_floor: 1,
      seasoning_range: 0.3,
      seasoning_days: 1460,
      unknown_age_days: 730,
      momentum_weight: 0.25,
      momentum_floor: -60,
      momentum_cap: 120,
    };
  }

  // Round 0 is plain OLS; each later round down-weights the rows Huber calls outliers.
  let weights = rows.map(() => 1);
  let fit = weightedLogFit(rows, weights);
  for (let round = 0; round < IRLS_ROUNDS; round++) {
    const spread = MAD_TO_SIGMA * median(fit.residuals.map(Math.abs));
    const cutoff = HUBER_K * (spread > 0 ? spread : 1);
    weights = fit.residuals.map((r) => {
      const a = Math.abs(r);
      return a <= cutoff ? 1 : cutoff / a;
    });
    fit = weightedLogFit(rows, weights);
  }

  // R-squared against the mean, and the residual sigma, both in log space.
  const meanLogValue = rows.reduce((s, p) => s + Math.log(p.mcap_usd as number), 0) / n;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const r = fit.residuals[i]!;
    sse += r * r;
    const d = Math.log(rows[i]!.mcap_usd as number) - meanLogValue;
    sst += d * d;
  }
  const rSquared = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  const sigma = Math.sqrt(sse / n);
  const insideThree = fit.residuals.filter((r) => Math.abs(r) <= Math.log(3)).length / n;

  // Category factors: the median residual of the category's comparables, shrunk toward 1 by a
  // CATEGORY_PRIOR-observation prior, then clamped. A category the fit has never seen is 1.
  const byCategory = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = rows[i]!.category ?? 'Other';
    const bucket = byCategory.get(key);
    if (bucket === undefined) byCategory.set(key, [fit.residuals[i]!]);
    else bucket.push(fit.residuals[i]!);
  }
  const categoryFactors: Record<string, number> = {};
  let categoryLogSum = 0;
  for (const [key, residuals] of byCategory) {
    const shrunk = (residuals.length / (residuals.length + CATEGORY_PRIOR)) * median(residuals);
    const factor = Math.min(CATEGORY_CAP, Math.max(CATEGORY_FLOOR, Math.exp(shrunk)));
    categoryFactors[key] = roundTo4(factor);
    categoryLogSum += Math.log(categoryFactors[key]!) * residuals.length;
  }

  // Re-centre the intercept so the fitted category factors multiply out to 1 across the comparables:
  // a category nobody has seen then reads at the curve, not below or above it.
  const intercept = fit.intercept - categoryLogSum / n;
  // The base-10 exponent is the one the page prints, so the natural-log intercept is derived from it
  // rather than the other way round: the two fields can then never disagree by a rounding step.
  const interceptLog10 = roundTo4(intercept / Math.LN10);

  return {
    elasticity: roundTo4(fit.elasticity),
    intercept_log10: interceptLog10,
    intercept_ln: roundTo4(interceptLog10 * Math.LN10),
    scale: Math.round(Math.pow(10, interceptLog10)),
    r_squared: roundTo4(rSquared),
    residual_sigma: roundTo4(sigma),
    within_factor_3: roundTo4(insideThree),
    comparables: n,
    comparables_excluded: withBoth - n,
    category_factors: categoryFactors,
    category_prior: CATEGORY_PRIOR,
    category_floor: CATEGORY_FLOOR,
    category_cap: CATEGORY_CAP,
    // Seasoning: 1.00 at day zero to 1.30 at four years, then flat. See the header for why it is
    // deliberately a fifth of the drift the comparables themselves show.
    seasoning_floor: 1,
    seasoning_range: 0.3,
    seasoning_days: 1460,
    unknown_age_days: 730,
    // Momentum: a quarter of the week's move, pinned inside [-60, 120] per cent, so at most +15% / -15%.
    momentum_weight: 0.25,
    momentum_floor: -60,
    momentum_cap: 120,
  };
}

/** The model a board is scored with: `MODEL` is what main.ts and the page both import. */
export const MODEL: ModelConstants = {
  elasticity: 0,
  intercept_ln: 0,
  intercept_log10: 0,
  scale: 0,
  r_squared: 0,
  residual_sigma: 0,
  within_factor_3: 0,
  comparables: 0,
  comparables_excluded: 0,
  category_factors: {},
  category_prior: CATEGORY_PRIOR,
  category_floor: CATEGORY_FLOOR,
  category_cap: CATEGORY_CAP,
  seasoning_floor: 1,
  seasoning_range: 0.3,
  seasoning_days: 1460,
  unknown_age_days: 730,
  momentum_weight: 0.25,
  momentum_floor: -60,
  momentum_cap: 120,
};

/**
 * The model for one snapshot: the fitted constants, with a curve fitted only when the snapshot
 * actually carries comparables, so `MODEL`'s zeros are never what a board is scored on.
 */
function modelFor(snapshot: Snapshot, model: ModelConstants | undefined): ModelConstants {
  if (model !== undefined) return model;
  const fitted = fitModel(snapshot);
  return fitted.comparables > 0 ? fitted : MODEL;
}

// ------------------------------------------------------------------ the value model

/** How many times a multiplier is allowed to move a value, so one bad week cannot carry a row. */
function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return 1;
  return Math.min(10, Math.max(0.1, m));
}

/** The fitted category multiplier for a record; 1 for a category the fit has never seen. */
export function categoryFactor(model: ModelConstants, category: string | null): number {
  if (category === null) return 1;
  const factor = model.category_factors[category];
  return typeof factor === 'number' && Number.isFinite(factor) ? factor : 1;
}

/**
 * One protocol's implied value under `model`, with the inputs that produced it so the board can show
 * its work. The shape is unchanged from radar-1: `growthPct`, `growthMult` and `maturityMult` keep
 * their names and their meaning (momentum and seasoning), and `fitValue` is the fitted power law alone
 * before either of them touches it.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
  categoryMult: number;
  fitValue: number;
} {
  const age = ageDays(asOf, protocol.listed_at);

  // Momentum: the week's change, pinned, at a quarter weight.
  const reportedGrowth = realNumber(protocol.change_7d, 0);
  const growthPct = Math.min(model.momentum_cap, Math.max(model.momentum_floor, reportedGrowth));
  const growthMult = clampMultiplier(1 + (growthPct / 100) * model.momentum_weight);

  // Seasoning: how long the protocol has held TVL with no token, capped at four years.
  const ageForModel = age ?? model.unknown_age_days;
  const held = Math.min(Math.max(ageForModel, 0), model.seasoning_days);
  const maturityMult = clampMultiplier(model.seasoning_floor + (held / model.seasoning_days) * model.seasoning_range);

  // The fitted power law: value = a * TVL^elasticity.
  const tvl = protocol.tvl_usd > 0 ? protocol.tvl_usd : 1;
  const fitValue = model.scale * Math.pow(tvl, model.elasticity);
  const categoryMult = clampMultiplier(categoryFactor(model, protocol.category));

  const implied = Math.max(1, Math.round(fitValue * categoryMult * maturityMult * growthMult));
  return { implied, growthPct, growthMult, maturityMult, age, categoryMult, fitValue };
}

/** The fitted formula as one line, with this snapshot's fitted numbers already in it. */
export function modelFormula(model: ModelConstants): string {
  return (
    `value = 10^${model.intercept_log10} x TVL^${model.elasticity}` +
    ` x category (fitted, ${model.category_floor}..${model.category_cap})` +
    ` x seasoning (${model.seasoning_floor} + min(age_days, ${model.seasoning_days}) / ${model.seasoning_days} x ${model.seasoning_range})` +
    ` x momentum (1 + clamp(change_7d, ${model.momentum_floor}, ${model.momentum_cap}) / 100 x ${model.momentum_weight})` +
    `  |  fitted on ${model.comparables} comparables`
  );
}

/** The fit, stated in the words the page prints: what it explains and how often it is close. */
export function modelStatement(model: ModelConstants): string {
  const missFactor = Math.exp(model.residual_sigma);
  return (
    `A power law fitted on the ${model.comparables} protocols that carry both a TVL and a market cap: ` +
    `elasticity ${model.elasticity} means a 1% rise in TVL is worth about ${model.elasticity}% of market cap. ` +
    `TVL explains ${Math.round(model.r_squared * 100)}% of the spread in log space, so the typical miss is a factor of ` +
    `${missFactor.toFixed(1)}; ${Math.round(model.within_factor_3 * 100)}% of comparables land within a factor of 3 of the curve. ` +
    `R-squared is the honest number here: TVL is not the whole business, and the size of that gap is the point.`
  );
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
export function buildBoard(snapshot: Snapshot, model?: ModelConstants): BoardRow[] {
  const m = modelFor(snapshot, model);
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

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, m) }));
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
      // The implied multiple of TVL this row's implied value works out to: on the fitted curve it
      // is exactly a * TVL^(elasticity - 1) * the three multipliers, which is what the page checks.
      base_multiple: roundTo4(s.implied / (s.p.tvl_usd > 0 ? s.p.tvl_usd : 1)),
      growth_pct: s.growthPct,
      growth_multiplier: roundTo4(s.growthMult),
      maturity_multiplier: roundTo4(s.maturityMult),
      age_days: s.age,
      category_multiplier: roundTo4(s.categoryMult),
      fit_value_usd: Math.max(1, Math.round(s.fitValue)),
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
    category_multiplier: row.model.category_multiplier,
    fit_value_usd: row.model.fit_value_usd,
  };
}

/** The board and the dashboard's dataset, from one pass: main.ts writes both from this. */
export function buildRadar(snapshot: Snapshot, model?: ModelConstants): { board: BoardRow[]; radar: RadarData } {
  const m = modelFor(snapshot, model);
  const board = buildBoard(snapshot, m);
  const live = liveRows(snapshot);
  const onWatchlist = new Set(snapshot.watchlist);
  const earlySize = board.filter((r) => !onWatchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: m,
    formula: modelFormula(m),
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
