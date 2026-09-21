/*
 * 调度器核心：优先级 + 抢占 + 时间片轮转 + 依赖 DAG + 超时重试 + 死锁检测 + 优先级继承。
 * 纯逻辑、无 DOM 依赖：
 *  - 浏览器中由 main.js 通过 Blob 包装成 Web Worker 运行（schedulerWorkerMain）
 *  - Node 中可直接 require 用于自动化测试
 *
 * 任务状态机：pending(等待依赖) → ready(就绪) → running(运行) → done(完成)
 *                                                  ↘ (超时重试耗尽/依赖失败) → failed
 *             pending ↘ (循环等待) → deadlocked
 */
'use strict';

class Scheduler {
  constructor(tasks, config) {
    this.config = Object.assign({ cores: 2, quantum: 4, inheritance: true }, config || {});
    this.reset(tasks);
  }

  reset(tasks) {
    this.tick = 0;
    this.done = false;
    this.events = [];
    this.tasks = new Map();
    for (const t of tasks) {
      this.tasks.set(t.id, {
        id: t.id,
        name: t.name || t.id,
        priority: t.priority,          // 静态优先级，越大数值越大越高
        duration: t.duration,          // 单次尝试需要的 tick 数
        deps: (t.deps || []).slice(),
        timeout: t.timeout || 0,       // 单次尝试允许的最长运行 tick，0 表示不限
        maxRetries: t.maxRetries || 0,
        color: t.color || '#999',
        state: (t.deps && t.deps.length) ? 'pending' : 'ready',
        remaining: t.duration,
        runTime: 0,                    // 本次尝试已运行时间（用于超时判定）
        attempts: 0,                   // 已超时次数
        sliceUsed: 0,                  // 当前时间片已用
        effPri: t.priority,            // 有效优先级（继承提升后）
        boosted: false,
        core: -1,
        lastRun: 0,                    // 最近一次运行的 tick（时间片公平性依据）
        loggedBoost: 0,
      });
    }
    this.cores = new Array(this.config.cores).fill(null);
  }

  emit(type, taskId, msg) {
    this.events.push({ tick: this.tick, type, taskId, msg });
  }

  /** 就绪队列：有效优先级降序；同级按最久未运行排序（保证时间片公平） */
  readyList() {
    return [...this.tasks.values()]
      .filter(t => t.state === 'ready')
      .sort((a, b) => b.effPri - a.effPri || a.lastRun - b.lastRun || (a.id < b.id ? -1 : 1));
  }

  /** 死锁检测：在等待图上做 DFS 三色标记，灰色回边即循环等待 */
  detectDeadlock() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const cycle = [];
    const active = t => t.state !== 'done' && t.state !== 'failed' && t.state !== 'deadlocked';

    const visit = (id, stack) => {
      color.set(id, GRAY);
      stack.push(id);
      for (const depId of this.tasks.get(id).deps) {
        const d = this.tasks.get(depId);
        if (!d || !active(d)) continue;
        const c = color.get(depId) || WHITE;
        if (c === GRAY) {
          cycle.push(...stack.slice(stack.indexOf(depId)));
        } else if (c === WHITE) {
          visit(depId, stack);
        }
      }
      stack.pop();
      color.set(id, BLACK);
    };

    for (const [id, t] of this.tasks) {
      if (active(t) && !(color.get(id))) visit(id, []);
    }
    for (const id of new Set(cycle)) {
      const t = this.tasks.get(id);
      t.state = 'deadlocked';
      if (t.core >= 0) { this.cores[t.core] = null; t.core = -1; }
      this.emit('deadlock', id, `检测到死锁：${id} 处于循环等待链 [${[...new Set(cycle)].join(' → ')}]`);
    }
  }

  /** 异常链路：依赖失败/死锁的任务永远无法满足，级联标记失败 */
  cascadeFailures() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.tasks.values()) {
        if (t.state !== 'pending' && t.state !== 'ready') continue;
        const bad = t.deps.find(d => {
          const s = this.tasks.get(d) && this.tasks.get(d).state;
          return s === 'failed' || s === 'deadlocked';
        });
        if (bad) {
          t.state = 'failed';
          const reason = this.tasks.get(bad).state === 'deadlocked' ? '死锁' : '失败';
          this.emit('cascade', t.id, `${t.id} 因依赖 ${bad} ${reason}而级联失败（异常链路）`);
          changed = true;
        }
      }
    }
  }

  /** 依赖全部完成 → 进入就绪 */
  updateReady() {
    for (const t of this.tasks.values()) {
      if (t.state === 'pending' && t.deps.every(d => this.tasks.get(d).state === 'done')) {
        t.state = 'ready';
        this.emit('ready', t.id, `${t.id} 依赖已完成，进入就绪队列`);
      }
    }
  }

  /**
   * 优先级继承（解除优先级反转）：
   * 若高优先级任务 H 等待低优先级任务 L（直接或间接），则 L 的有效优先级提升到 H。
   * 迭代到不动点，支持依赖链传递。
   */
  computeEffectivePriorities() {
    for (const t of this.tasks.values()) { t.effPri = t.priority; t.boosted = false; }
    if (!this.config.inheritance) return;
    const finished = t => t.state === 'done' || t.state === 'failed' || t.state === 'deadlocked';
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.tasks.values()) {
        if (finished(t)) continue;
        for (const depId of t.deps) {
          const d = this.tasks.get(depId);
          if (!d || d.state === 'done') continue;
          if (d.effPri < t.effPri) { d.effPri = t.effPri; changed = true; }
        }
      }
    }
    for (const t of this.tasks.values()) {
      if (t.effPri > t.priority) {
        t.boosted = true;
        if (t.loggedBoost < t.effPri) {
          t.loggedBoost = t.effPri;
          this.emit('boost', t.id, `${t.id} 优先级继承 ${t.priority} → ${t.effPri}（解除优先级反转）`);
        }
      }
    }
  }

  /** 抢占：就绪队首有效优先级高于运行中最低者 → 换出 */
  preempt() {
    for (;;) {
      const ready = this.readyList();
      if (!ready.length) return;
      const top = ready[0];
      let lowCore = -1, lowPri = Infinity;
      for (let c = 0; c < this.cores.length; c++) {
        const id = this.cores[c];
        if (!id) continue;
        const t = this.tasks.get(id);
        if (t.effPri < lowPri) { lowPri = t.effPri; lowCore = c; }
      }
      if (lowCore < 0 || top.effPri <= lowPri) return;
      const victim = this.tasks.get(this.cores[lowCore]);
      this.cores[lowCore] = null;
      victim.core = -1;
      victim.state = 'ready';
      victim.sliceUsed = 0;
      this.emit('preempt', victim.id,
        `${victim.id}(P${victim.effPri}) 被 ${top.id}(P${top.effPri}) 抢占，进度保留 ${victim.duration - victim.remaining}/${victim.duration}`);
    }
  }

  /** 时间片轮转 + 空闲核心分派 */
  rotateAndDispatch() {
    // 时间片到期：同级仍有就绪任务则轮换，否则续期
    for (let c = 0; c < this.cores.length; c++) {
      const id = this.cores[c];
      if (!id) continue;
      const t = this.tasks.get(id);
      if (t.sliceUsed >= this.config.quantum) {
        const alt = this.readyList().find(r => r.effPri === t.effPri);
        if (alt) {
          this.cores[c] = null;
          t.core = -1;
          t.state = 'ready';
          t.sliceUsed = 0;
          this.emit('slice', t.id, `${t.id} 时间片(${this.config.quantum})到期，轮换给 ${alt.id}（公平性）`);
        } else {
          t.sliceUsed = 0; // 无同级竞争者，续期
        }
      }
    }
    // 空闲核心取就绪队首
    for (let c = 0; c < this.cores.length; c++) {
      if (this.cores[c]) continue;
      const next = this.readyList()[0];
      if (!next) return;
      next.state = 'running';
      next.core = c;
      next.sliceUsed = 0;
      this.cores[c] = next.id;
      this.emit('dispatch', next.id, `${next.id} → CPU${c}（有效优先级 ${next.effPri}）`);
    }
  }

  /** 推进一个 tick：超时判定 → 重试/失败，完成判定 */
  runTick() {
    for (let c = 0; c < this.cores.length; c++) {
      const id = this.cores[c];
      if (!id) continue;
      const t = this.tasks.get(id);
      t.remaining--;
      t.runTime++;
      t.sliceUsed++;
      t.lastRun = this.tick;

      if (t.timeout && t.runTime >= t.timeout && t.remaining > 0) {
        this.cores[c] = null;
        t.core = -1;
        t.attempts++;
        if (t.attempts <= t.maxRetries) {
          t.state = 'ready';
          t.runTime = 0;
          t.sliceUsed = 0;
          t.remaining = t.duration; // 重试语义：从头重新执行
          this.emit('timeout', t.id, `${t.id} 运行超时(${t.timeout}t)，第 ${t.attempts}/${t.maxRetries} 次重试`);
        } else {
          t.state = 'failed';
          this.emit('fail', t.id, `${t.id} 超时且重试耗尽(${t.maxRetries}次)，标记失败`);
        }
        continue;
      }
      if (t.remaining <= 0) {
        this.cores[c] = null;
        t.core = -1;
        t.state = 'done';
        this.emit('done', t.id, `${t.id} 执行完成`);
      }
    }
  }

  checkDone() {
    this.done = [...this.tasks.values()]
      .every(t => t.state === 'done' || t.state === 'failed' || t.state === 'deadlocked');
    if (this.done) this.emit('finished', null, '所有任务已终结（完成 / 失败 / 死锁）');
  }

  step() {
    if (this.done) return;
    this.events = [];
    this.tick++;
    this.detectDeadlock();
    this.cascadeFailures();
    this.updateReady();
    this.computeEffectivePriorities();
    this.preempt();
    this.rotateAndDispatch();
    this.runTick();
    this.checkDone();
  }

  snapshot() {
    return {
      tick: this.tick,
      config: { cores: this.config.cores, quantum: this.config.quantum, inheritance: this.config.inheritance },
      cores: this.cores.map(id => id ? { id, slice: this.tasks.get(id).sliceUsed } : null),
      tasks: [...this.tasks.values()].map(t => ({
        id: t.id, name: t.name, state: t.state,
        priority: t.priority, effPri: t.effPri, boosted: t.boosted,
        deps: t.deps.slice(), duration: t.duration, remaining: t.remaining,
        progress: +(1 - t.remaining / t.duration).toFixed(3),
        attempts: t.attempts, maxRetries: t.maxRetries, timeout: t.timeout,
        sliceUsed: t.sliceUsed, color: t.color,
      })),
      events: this.events.slice(),
      finished: this.done,
    };
  }
}

/* Web Worker 入口：被 main.js 以 Blob 方式加载（兼容 file:// 直接打开） */
function schedulerWorkerMain() {
  let sched = null;
  let timer = null;
  let tps = 5;

  const post = () => self.postMessage({ type: 'snapshot', snap: sched.snapshot() });
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const loop = () => {
    if (!sched || sched.done) { stopTimer(); return; }
    sched.step();
    post();
    if (sched.done) { stopTimer(); self.postMessage({ type: 'finished' }); }
  };

  self.onmessage = e => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        stopTimer();
        sched = new Scheduler(m.tasks, m.config);
        post();
        break;
      case 'start':
        if (sched && !timer && !sched.done) timer = setInterval(loop, 1000 / tps);
        break;
      case 'pause':
        stopTimer();
        break;
      case 'step':
        if (sched && !timer && !sched.done) loop();
        break;
      case 'speed':
        tps = m.tps;
        if (timer) { stopTimer(); timer = setInterval(loop, 1000 / tps); }
        break;
      case 'config':
        if (sched) Object.assign(sched.config, m.config);
        break;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Scheduler, schedulerWorkerMain };
}
