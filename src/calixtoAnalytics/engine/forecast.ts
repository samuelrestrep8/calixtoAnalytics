/**
 * Random Forest de regresión en TypeScript.
 * Réplica funcional del RandomForestRegressor usado en prediction_agent.py
 * (no hay runtime de Python en este entorno de ejecución).
 */

export type Sample = { x: number[]; y: number };

type Node =
  | { leaf: true; value: number }
  | { leaf: false; feature: number; threshold: number; left: Node; right: Node };

function mean(values: number[]): number {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function sse(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return s;
}

function makeRng(seed: number) {
  let state = seed || 42;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildTree(
  samples: Sample[],
  depth: number,
  maxDepth: number,
  minLeaf: number,
  featureCount: number,
  rng: () => number,
): Node {
  const ys = samples.map((s) => s.y);
  if (depth >= maxDepth || samples.length <= minLeaf * 2) {
    return { leaf: true, value: mean(ys) };
  }

  const parentSse = sse(ys);
  if (parentSse <= 1e-9) return { leaf: true, value: mean(ys) };

  const featureOrder: number[] = [];
  for (let f = 0; f < featureCount; f++) featureOrder.push(f);
  // max_features ~ sqrt + 1 features por split, elegidas al azar
  const tryCount = Math.max(1, Math.min(featureCount, Math.ceil(Math.sqrt(featureCount)) + 1));
  for (let i = featureOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [featureOrder[i], featureOrder[j]] = [featureOrder[j]!, featureOrder[i]!];
  }

  let best: { feature: number; threshold: number; gain: number } | null = null;

  for (let k = 0; k < tryCount; k++) {
    const feature = featureOrder[k]!;
    const values = Array.from(new Set(samples.map((s) => s.x[feature]!))).sort((a, b) => a - b);
    if (values.length < 2) continue;

    const maxCandidates = 12;
    const step = Math.max(1, Math.floor(values.length / maxCandidates));
    for (let vi = step; vi < values.length; vi += step) {
      const threshold = (values[vi - 1]! + values[vi]!) / 2;
      const leftY: number[] = [];
      const rightY: number[] = [];
      for (const s of samples) (s.x[feature]! <= threshold ? leftY : rightY).push(s.y);
      if (leftY.length < minLeaf || rightY.length < minLeaf) continue;
      const gain = parentSse - (sse(leftY) + sse(rightY));
      if (gain > 0 && (!best || gain > best.gain)) best = { feature, threshold, gain };
    }
  }

  if (!best) return { leaf: true, value: mean(ys) };

  const left: Sample[] = [];
  const right: Sample[] = [];
  for (const s of samples) (s.x[best.feature]! <= best.threshold ? left : right).push(s);

  return {
    leaf: false,
    feature: best.feature,
    threshold: best.threshold,
    left: buildTree(left, depth + 1, maxDepth, minLeaf, featureCount, rng),
    right: buildTree(right, depth + 1, maxDepth, minLeaf, featureCount, rng),
  };
}

function predictNode(node: Node, x: number[]): number {
  let current = node;
  while (!current.leaf) {
    current = x[current.feature]! <= current.threshold ? current.left : current.right;
  }
  return current.value;
}

export class RandomForestRegressor {
  private trees: Node[] = [];
  private featureCount = 0;

  constructor(
    private nEstimators = 20,
    private maxDepth = 7,
    private minLeaf = 2,
    private seed = 42,
  ) {}

  fit(samples: Sample[]): this {
    if (!samples.length) return this;
    this.featureCount = samples[0]!.x.length;
    const rng = makeRng(this.seed);
    this.trees = [];
    for (let t = 0; t < this.nEstimators; t++) {
      const bag: Sample[] = [];
      for (let i = 0; i < samples.length; i++) {
        bag.push(samples[Math.floor(rng() * samples.length)]!);
      }
      this.trees.push(buildTree(bag, 0, this.maxDepth, this.minLeaf, this.featureCount, rng));
    }
    return this;
  }

  predict(x: number[]): number {
    if (!this.trees.length) return 0;
    let s = 0;
    for (const tree of this.trees) s += predictNode(tree, x);
    return s / this.trees.length;
  }

  /** R² sobre las muestras dadas, equivalente a model.score() de sklearn. */
  score(samples: Sample[]): number {
    if (samples.length < 2) return 0;
    const ys = samples.map((s) => s.y);
    const total = sse(ys);
    if (total <= 1e-9) return 0;
    let residual = 0;
    for (const s of samples) {
      const d = s.y - this.predict(s.x);
      residual += d * d;
    }
    return Math.max(0, Math.min(1, 1 - residual / total));
  }
}
