// 브라우저 Web Worker (module). run.js 가 띄움.
//  init     : 입력 준비. 리더 워커는 1·2단계(기여도 포함)를 하고 가공 정책표를 만들어 돌려줌
//  run      : 몬테카를로 묶음 b 를 n회 돌려 보유 젬별 사용 횟수 반환
//  finalize : (리더만) 합친 사용 횟수로 최종 판정 결과 반환
import { prepare, runBatch, finalize, exportPolicies, importPolicies } from '../core.js';

let ctx = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      if (m.policies) importPolicies(m.policies);
      ctx = prepare(m.input, { withDelta: !!m.lead });
      self.postMessage({ type: 'ready', policies: m.lead ? exportPolicies() : null });
    } else if (m.type === 'run') {
      self.postMessage({ type: 'counts', counts: runBatch(ctx, m.b, m.n), n: m.n });
    } else if (m.type === 'finalize') {
      self.postMessage({ type: 'result', result: finalize(ctx, m.counts, m.iterations) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
