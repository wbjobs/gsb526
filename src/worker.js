import { Scheduler } from './scheduler.js';

let scheduler = null;

self.onmessage = (event) => {
  const { type, config, count = 1 } = event.data ?? {};
  try {
    if (type === 'init') {
      scheduler = new Scheduler(config);
      self.postMessage({ type: 'snapshot', snapshot: scheduler.snapshot() });
      return;
    }
    if (!scheduler) throw new Error('调度器尚未初始化');

    if (type === 'reset') {
      scheduler = scheduler.reset();
      self.postMessage({ type: 'snapshot', snapshot: scheduler.snapshot() });
      return;
    }
    if (type === 'tick') {
      let snapshot = null;
      for (let index = 0; index < Math.max(1, count); index += 1) {
        snapshot = scheduler.tick();
        if (snapshot.finished) break;
      }
      self.postMessage({ type: 'snapshot', snapshot });
      return;
    }
    throw new Error(`未知 Worker 消息: ${type}`);
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: {
        name: error.name ?? 'Error',
        message: error.message,
        details: error.details ?? null
      }
    });
  }
};
