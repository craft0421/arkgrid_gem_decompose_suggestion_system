// 브라우저에서 엔진 실행 (Web Worker 병렬). 메인 스레드는 계산하지 않아 화면이 멈추지 않음.
// 결과 형식은 Node의 evaluate()/evaluateParallel()과 같고, 같은 입력·시드면 결과도 같다 (묶음 시드).
import { DEFAULT_SETTINGS, BATCH_SIZE } from '../core.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

/**
 * input: { cores, gems, settings }
 * opts.workers: 워커 수 (기본: 논리 코어 − 1, 최대 8)
 * opts.onProgress(done, total), opts.signal: AbortSignal (취소 시 워커 종료)
 */
export function evaluateInBrowser(input, opts = {}) {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const nWorkers = Math.max(1, Math.min(opts.workers ?? hc - 1, 8));
  const total = (input.settings && input.settings.iterations) || DEFAULT_SETTINGS.iterations;
  const batches = [];
  for (let b = 0, done = 0; done < total; b++, done += BATCH_SIZE) batches.push({ b, n: Math.min(BATCH_SIZE, total - done) });

  return new Promise((resolve, reject) => {
    const workers = [];
    let finished = 0, next = 0, counts = null, settled = false, idle = 0;
    const stop = () => workers.forEach((w) => w.terminate());
    const fail = (err) => { if (settled) return; settled = true; stop(); reject(err); };
    if (opts.signal) {
      if (opts.signal.aborted) return fail(new DOMException('계산 취소', 'AbortError'));
      opts.signal.addEventListener('abort', () => fail(new DOMException('계산 취소', 'AbortError')), { once: true });
    }
    const spawn = () => {
      const w = new Worker(WORKER_URL, { type: 'module' });
      w.onerror = (e) => fail(new Error(e.message || '워커 오류'));
      workers.push(w);
      return w;
    };
    const give = (w) => {
      if (next < batches.length) { w.postMessage({ type: 'run', ...batches[next++] }); return; }
      idle++;
      if (idle === workers.length && finished === total) lead.postMessage({ type: 'finalize', counts, iterations: total });
    };
    const onMessage = (w) => (e) => {
      const m = e.data;
      if (settled) return;
      if (m.type === 'error') return fail(new Error(m.message));
      if (m.type === 'ready') {
        if (w === lead) {
          // 리더가 만든 가공 정책표를 넘겨서 나머지 워커는 다시 계산하지 않음
          for (let i = 1; i < nWorkers; i++) {
            const o = spawn();
            o.onmessage = onMessage(o);
            o.postMessage({ type: 'init', input, lead: false, policies: m.policies });
          }
        }
        give(w);
      } else if (m.type === 'counts') {
        if (!counts) counts = new Array(m.counts.length).fill(0);
        m.counts.forEach((x, i) => { counts[i] += x; });
        finished += m.n;
        if (opts.onProgress) opts.onProgress(finished, total);
        give(w);
      } else if (m.type === 'result') {
        settled = true; stop(); resolve(m.result);
      }
    };
    const lead = spawn();
    lead.onmessage = onMessage(lead);
    lead.postMessage({ type: 'init', input, lead: true });
  });
}
