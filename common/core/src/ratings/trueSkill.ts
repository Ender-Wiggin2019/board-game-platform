/**
 * Dependency-free TrueSkill factor graph.
 *
 * This is intentionally a small generic kernel.  Game policy bundles own
 * their constants and progression rules; the platform never imports a game
 * package to rate a remote completion.
 */

export interface TrueSkillConfiguration {
  readonly mu: number;
  readonly sigma: number;
  readonly beta: number;
  readonly tau: number;
  readonly drawProbability: number;
  readonly minDelta?: number;
}

export interface TrueSkillRating {
  readonly mu: number;
  readonly sigma: number;
}

const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const polynomial =
    1.00002368 +
    t *
      (0.37409196 +
        t *
          (0.09678418 +
            t *
              (-0.18628806 +
                t *
                  (0.27886807 +
                    t *
                      (-1.13520398 +
                        t *
                          (1.48851587 +
                            t * (-0.82215223 + t * 0.17087277)))))));
  const r = t * Math.exp(-z * z - 1.26551223 + t * polynomial);
  return x >= 0 ? r : 2 - r;
}

function inverseErfc(x: number): number {
  if (x >= 2) return -100;
  if (x <= 0) return 100;
  const xx = x < 1 ? x : 2 - x;
  const t = Math.sqrt(-2 * Math.log(xx / 2));
  let result =
    -0.70711 *
    ((2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t);
  for (let index = 0; index < 2; index += 1) {
    const error = erfc(result) - xx;
    result +=
      error /
      (1.1283791670955126 * Math.exp(-(result * result)) - result * error);
  }
  return x < 1 ? result : -result;
}

function cdf(x: number): number {
  return 0.5 * erfc(-x / Math.sqrt(2));
}

function pdf(x: number): number {
  return Math.exp(-(x * x) / 2) / SQRT_TWO_PI;
}

function ppf(x: number): number {
  return -Math.sqrt(2) * inverseErfc(2 * x);
}

function drawMargin(
  drawProbability: number,
  size: number,
  configuration: TrueSkillConfiguration,
): number {
  return ppf((drawProbability + 1) / 2) * Math.sqrt(size) * configuration.beta;
}

class Gaussian {
  constructor(
    readonly pi: number,
    readonly tau: number,
  ) {}

  static fromRating(rating: TrueSkillRating): Gaussian {
    const pi = rating.sigma ** -2;
    return new Gaussian(pi, pi * rating.mu);
  }

  get mu(): number {
    return this.pi ? this.tau / this.pi : 0;
  }

  get sigma(): number {
    return this.pi ? Math.sqrt(1 / this.pi) : Number.POSITIVE_INFINITY;
  }

  mul(other: Gaussian): Gaussian {
    return new Gaussian(this.pi + other.pi, this.tau + other.tau);
  }

  div(other: Gaussian): Gaussian {
    return new Gaussian(this.pi - other.pi, this.tau - other.tau);
  }
}

let factorId = 0;

class Variable extends Gaussian {
  readonly messages = new Map<number, Gaussian>();

  constructor() {
    super(0, 0);
  }

  setValue(value: Gaussian): number {
    const delta = this.delta(value);
    Object.assign(this, { pi: value.pi, tau: value.tau });
    return delta;
  }

  delta(other: Gaussian): number {
    const piDelta = Math.abs(this.pi - other.pi);
    if (piDelta === Number.POSITIVE_INFINITY) return 0;
    return Math.max(Math.abs(this.tau - other.tau), Math.sqrt(piDelta));
  }

  updateMessage(factor: Factor, message: Gaussian): number {
    const old = this.messages.get(factor.id) ?? new Gaussian(0, 0);
    this.messages.set(factor.id, message);
    return this.setValue(this.div(old).mul(message));
  }

  updateValue(factor: Factor, value: Gaussian): number {
    const old = this.messages.get(factor.id) ?? new Gaussian(0, 0);
    this.messages.set(factor.id, value.mul(old).div(this));
    return this.setValue(value);
  }
}

abstract class Factor {
  readonly id = factorId++;

  constructor(readonly vars: readonly Variable[]) {
    for (const variable of vars)
      variable.messages.set(this.id, new Gaussian(0, 0));
  }
}

class PriorFactor extends Factor {
  constructor(
    variable: Variable,
    private readonly rating: TrueSkillRating,
    private readonly dynamic: number,
  ) {
    super([variable]);
  }

  down(): number {
    return this.vars[0].updateValue(
      this,
      new Gaussian(
        1 / (this.rating.sigma ** 2 + this.dynamic ** 2),
        this.rating.mu / (this.rating.sigma ** 2 + this.dynamic ** 2),
      ),
    );
  }
}

class LikelihoodFactor extends Factor {
  constructor(
    private readonly mean: Variable,
    private readonly value: Variable,
    private readonly variance: number,
  ) {
    super([mean, value]);
  }

  private calcA(variable: Gaussian): number {
    return 1 / (this.variance * variable.pi + 1);
  }

  down(): number {
    const message = this.mean.div(
      this.mean.messages.get(this.id) ?? new Gaussian(0, 0),
    );
    const a = this.calcA(message);
    return this.value.updateMessage(
      this,
      new Gaussian(a * message.pi, a * message.tau),
    );
  }

  up(): number {
    const message = this.value.div(
      this.value.messages.get(this.id) ?? new Gaussian(0, 0),
    );
    const a = this.calcA(message);
    return this.mean.updateMessage(
      this,
      new Gaussian(a * message.pi, a * message.tau),
    );
  }
}

class SumFactor extends Factor {
  constructor(
    private readonly sum: Variable,
    private readonly terms: readonly Variable[],
    private readonly coeffs: readonly number[],
  ) {
    super([sum, ...terms]);
  }

  down(): number {
    const messages = this.terms.map(
      (term) => term.messages.get(this.id) ?? new Gaussian(0, 0),
    );
    return this.update(this.sum, this.terms, messages, this.coeffs);
  }

  up(index: number): number {
    const coefficient = this.coeffs[index] as number;
    const coeffs = this.coeffs.map((value, current) => {
      let result = -value / coefficient;
      if (current === index) result = 1 / coefficient;
      if (!Number.isFinite(result) || coefficient === 0) result = 0;
      return result;
    });
    const values = [...this.terms];
    values[index] = this.sum;
    const messages = values.map(
      (value) => value.messages.get(this.id) ?? new Gaussian(0, 0),
    );
    return this.update(this.terms[index] as Variable, values, messages, coeffs);
  }

  private update(
    variable: Variable,
    values: readonly Variable[],
    messages: readonly Gaussian[],
    coeffs: readonly number[],
  ): number {
    let piInverse = 0;
    let mu = 0;
    for (let index = 0; index < values.length; index += 1) {
      const division = values[index].div(messages[index]);
      const coefficient = coeffs[index] as number;
      mu += coefficient * division.mu;
      if (Number.isFinite(piInverse))
        piInverse += coefficient ** 2 / division.pi;
    }
    const pi = 1 / piInverse;
    return variable.updateMessage(this, new Gaussian(pi, pi * mu));
  }
}

class TruncateFactor extends Factor {
  constructor(
    variable: Variable,
    private readonly vFunction: (diff: number, margin: number) => number,
    private readonly wFunction: (diff: number, margin: number) => number,
    private readonly margin: number,
  ) {
    super([variable]);
  }

  up(): number {
    const value = this.vars[0];
    const message = value.messages.get(this.id) ?? new Gaussian(0, 0);
    const division = value.div(message);
    const sqrtPi = Math.sqrt(division.pi);
    const v = this.vFunction(division.tau / sqrtPi, this.margin * sqrtPi);
    const w = this.wFunction(division.tau / sqrtPi, this.margin * sqrtPi);
    const denominator = 1 - w;
    return value.updateValue(
      this,
      new Gaussian(
        division.pi / denominator,
        (division.tau + sqrtPi * v) / denominator,
      ),
    );
  }
}

function rateGroups(
  groups: readonly (readonly TrueSkillRating[])[],
  ranks: readonly number[],
  configuration: TrueSkillConfiguration,
): readonly (readonly TrueSkillRating[])[] {
  const minDelta = configuration.minDelta ?? 0.0001;
  const sorted = groups
    .map((group, index) => ({ group, index, rank: ranks[index] as number }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ group, ...entry }) => ({
      ...entry,
      group: group.map((rating) => ({ ...rating })),
    }));
  const sortedGroups = sorted.map((entry) => entry.group);
  const sortedRanks = sorted.map((entry) => entry.rank);
  const weights = sortedGroups.map((group) =>
    group.map(() => Math.max(minDelta, 1)),
  );
  const flattened = sortedGroups.flat();
  const ratingVars = flattened.map(() => new Variable());
  const performanceVars = flattened.map(() => new Variable());
  const teamPerformanceVars = sortedGroups.map(() => new Variable());
  const teamDifferenceVars = sortedGroups.slice(1).map(() => new Variable());
  const teamSizes: number[] = [];
  let total = 0;
  for (const group of sortedGroups) {
    total += group.length;
    teamSizes.push(total);
  }
  const ratingLayer = ratingVars.map(
    (variable, index) =>
      new PriorFactor(
        variable,
        flattened[index] as TrueSkillRating,
        configuration.tau,
      ),
  );
  const performanceLayer = ratingVars.map(
    (variable, index) =>
      new LikelihoodFactor(
        variable,
        performanceVars[index] as Variable,
        configuration.beta ** 2,
      ),
  );
  const teamPerformanceLayer = teamPerformanceVars.map((variable, index) => {
    const start = index > 0 ? teamSizes[index - 1] : 0;
    return new SumFactor(
      variable,
      performanceVars.slice(start, teamSizes[index]),
      weights[index] as readonly number[],
    );
  });
  const teamDifferenceLayer = teamDifferenceVars.map(
    (variable, index) =>
      new SumFactor(
        variable,
        teamPerformanceVars.slice(index, index + 2),
        [1, -1],
      ),
  );
  const truncateLayer = teamDifferenceLayer.map((variable, index) => {
    const size =
      (sortedGroups[index]?.length ?? 0) +
      (sortedGroups[index + 1]?.length ?? 0);
    const margin = drawMargin(
      configuration.drawProbability,
      size,
      configuration,
    );
    const draw = sortedRanks[index] === sortedRanks[index + 1];
    return new TruncateFactor(
      variable.vars[0],
      draw
        ? (diff, value) => {
            const absolute = Math.abs(diff);
            const a = value - absolute;
            const b = -value - absolute;
            const denominator = cdf(a) - cdf(b);
            const numerator = pdf(b) - pdf(a);
            return (
              (denominator ? numerator / denominator : a) * (diff < 0 ? -1 : 1)
            );
          }
        : (diff, value) => {
            const x = diff - value;
            const denominator = cdf(x);
            return denominator ? pdf(x) / denominator : -x;
          },
      draw
        ? (diff, value) => {
            const absolute = Math.abs(diff);
            const a = value - absolute;
            const b = -value - absolute;
            const denominator = cdf(a) - cdf(b);
            if (!denominator) throw new Error('TRUE_SKILL_NUMERIC_ERROR');
            const v = (pdf(b) - pdf(a)) / denominator;
            return v ** 2 + (a * pdf(a) - b * pdf(b)) / denominator;
          }
        : (diff, value) => {
            const x = diff - value;
            const v = cdf(x) ? pdf(x) / cdf(x) : -x;
            const w = v * (v + x);
            if (!(w > 0 && w < 1)) throw new Error('TRUE_SKILL_NUMERIC_ERROR');
            return w;
          },
      margin,
    );
  });

  ratingLayer.forEach((factor) => factor.down());
  performanceLayer.forEach((factor) => factor.down());
  teamPerformanceLayer.forEach((factor) => factor.down());
  for (let iteration = 0; iteration <= 10; iteration += 1) {
    let delta = 0;
    if (teamDifferenceLayer.length === 1) {
      teamDifferenceLayer[0]?.down();
      delta = truncateLayer[0]?.up() ?? 0;
    } else {
      for (let index = 0; index < teamDifferenceLayer.length - 1; index += 1) {
        teamDifferenceLayer[index]?.down();
        delta = Math.max(delta, truncateLayer[index]?.up() ?? 0);
        teamDifferenceLayer[index]?.up(1);
      }
      for (let index = teamDifferenceLayer.length - 1; index > 0; index -= 1) {
        teamDifferenceLayer[index]?.down();
        delta = Math.max(delta, truncateLayer[index]?.up() ?? 0);
        teamDifferenceLayer[index]?.up(0);
      }
    }
    if (delta <= minDelta) break;
  }
  teamDifferenceLayer[0]?.up(0);
  teamDifferenceLayer[teamDifferenceLayer.length - 1]?.up(1);
  for (const factor of teamPerformanceLayer)
    for (let index = 0; index < factor.vars.length - 1; index += 1)
      factor.up(index);
  for (const factor of performanceLayer) factor.up();

  const transformed: Array<{
    readonly index: number;
    readonly group: readonly TrueSkillRating[];
  }> = [];
  let offset = 0;
  for (const entry of sorted) {
    const group = entry.group.map((_, index) => ({
      mu: ratingLayer[offset + index]?.vars[0]?.mu ?? Number.NaN,
      sigma: ratingLayer[offset + index]?.vars[0]?.sigma ?? Number.NaN,
    }));
    transformed.push({ index: entry.index, group });
    offset += entry.group.length;
  }
  return transformed
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.group);
}

/** Rate ordered teams with the same factor-graph semantics as ts-trueskill. */
export function rateTrueSkill(
  groups: readonly (readonly TrueSkillRating[])[],
  ranks: readonly number[],
  configuration: TrueSkillConfiguration,
): readonly (readonly TrueSkillRating[])[] {
  if (groups.length < 2 || ranks.length !== groups.length)
    throw new Error('TRUE_SKILL_GROUPS_INVALID');
  if (
    !Number.isFinite(configuration.mu) ||
    !Number.isFinite(configuration.sigma) ||
    configuration.sigma <= 0 ||
    !Number.isFinite(configuration.beta) ||
    configuration.beta <= 0 ||
    !Number.isFinite(configuration.tau) ||
    configuration.tau < 0 ||
    !Number.isFinite(configuration.drawProbability) ||
    configuration.drawProbability < 0 ||
    configuration.drawProbability >= 1
  )
    throw new Error('TRUE_SKILL_CONFIGURATION_INVALID');
  for (const group of groups) {
    if (group.length === 0) throw new Error('TRUE_SKILL_GROUP_EMPTY');
    for (const rating of group)
      if (
        !Number.isFinite(rating.mu) ||
        !Number.isFinite(rating.sigma) ||
        rating.sigma <= 0
      )
        throw new Error('TRUE_SKILL_RATING_INVALID');
  }
  return rateGroups(groups, ranks, configuration);
}
