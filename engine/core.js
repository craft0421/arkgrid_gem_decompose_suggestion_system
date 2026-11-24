// 브라우저·Node 공용 엔진 API (Node 전용 모듈 없음)
export { evaluate, prepare, runMonteCarlo, runBatch, finalize, DEFAULT_SETTINGS, BATCH_SIZE } from './evaluate.js';
export { makeCore, placementMultiplier, effectMultiplier, weaponParams, tierOf, chaosKind } from './cp.js';
export { makeGem, gemLabel, dealerEff } from './gem.js';
export { bestArrangement, bruteForceArrangement } from './arrange.js';
export { dominates, dominatorCounts } from './dominance.js';
export { getPolicy, simulateGem, simulateGemNaive, eligibleItems, makeUtility, exportPolicies, importPolicies } from './processing.js';
export { parseArkGrid, parseGem, parseCoreName, weaponParamsFromArmory, combatPower, summarizeArmory } from './armory.js';
export { makeRng } from './rng.js';
