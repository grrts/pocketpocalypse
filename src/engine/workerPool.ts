import type { InitMsg, JobRequest, WorkerRequest, WorkerResponse } from '../worker/protocol';

type Job = {
  id: number;
  req: WorkerRequest;
  priority: number;
  affinity: number;
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
};

/**
 * Prioritized job queue over a few map workers. Jobs that share map data
 * (chunks in the same z15 tile) go to the same worker so it is fetched once.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private inflight: number[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, Job>();
  private nextId = 1;
  readonly maxInflight = 2;

  constructor(count: number, init: InitMsg) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('../worker/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(i, ev.data);
      w.onerror = (e) => console.error('worker error', e.message);
      w.postMessage(init);
      this.workers.push(w);
      this.inflight.push(0);
    }
  }

  get queued(): number {
    return this.queue.length;
  }

  get busy(): number {
    return this.inflight.reduce((a, b) => a + b, 0);
  }

  /** Lower priority value runs first. */
  run<T extends WorkerResponse>(req: JobRequest, priority: number, affinity = -1): { promise: Promise<T>; cancel: () => void } {
    const id = this.nextId++;
    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = { id, req: { ...(req as WorkerRequest), id } as WorkerRequest, priority, affinity, resolve: resolve as (r: WorkerResponse) => void, reject, cancelled: false };
    });
    this.queue.push(job);
    this.pump();
    return {
      promise,
      cancel: () => {
        if (job.cancelled) return;
        const qi = this.queue.indexOf(job);
        if (qi >= 0) {
          job.cancelled = true;
          this.queue.splice(qi, 1);
          job.reject(new Error('cancelled'));
        }
      },
    };
  }

  reprioritize(fn: (req: WorkerRequest) => number): void {
    for (const j of this.queue) j.priority = fn(j.req);
  }

  private pump() {
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    for (let qi = 0; qi < this.queue.length; ) {
      const job = this.queue[qi];
      let wi = -1;
      if (job.affinity >= 0) {
        const w = job.affinity % this.workers.length;
        if (this.inflight[w] < this.maxInflight) wi = w;
      } else {
        let best = Infinity;
        for (let i = 0; i < this.workers.length; i++) {
          if (this.inflight[i] < this.maxInflight && this.inflight[i] < best) {
            best = this.inflight[i];
            wi = i;
          }
        }
      }
      if (wi < 0) {
        qi++;
        continue;
      }
      this.queue.splice(qi, 1);
      this.inflight[wi]++;
      this.pending.set(job.id, job);
      (job as Job & { worker: number }).worker = wi;
      this.workers[wi].postMessage(job.req);
    }
  }

  private onMessage(wi: number, msg: WorkerResponse) {
    const job = this.pending.get(msg.id);
    this.inflight[wi] = Math.max(0, this.inflight[wi] - 1);
    if (job) {
      this.pending.delete(msg.id);
      if (msg.type === 'error') job.reject(new Error(msg.message));
      else job.resolve(msg);
    }
    this.pump();
  }

  dispose() {
    for (const w of this.workers) w.terminate();
  }
}
