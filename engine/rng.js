// 재현 가능한 난수 (mulberry32)
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 가중치 배열에서 서로 다른 k개를 순차 비복원 추출 (인덱스 반환) */
export function drawDistinct(weights, k, rng) {
  const idx = weights.map((_, i) => i);
  const w = weights.slice();
  let total = w.reduce((s, x) => s + x, 0);
  const out = [];
  for (let n = 0; n < k && idx.length; n++) {
    let r = rng() * total;
    let j = 0;
    while (j < w.length - 1 && r >= w[j]) { r -= w[j]; j++; }
    out.push(idx[j]);
    total -= w[j];
    idx.splice(j, 1);
    w.splice(j, 1);
  }
  return out;
}
