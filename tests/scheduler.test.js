import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, TASK_STATE } from '../src/scheduler.js';
import { scenarios } from '../src/scenarios.js';

function run(config, maxTicks = 100) {
  const scheduler = new Scheduler(config);
  let snapshot = scheduler.snapshot();
  for (let tick = 0; tick < maxTicks && !snapshot.finished; tick += 1) {
    snapshot = scheduler.tick();
  }
  return { scheduler, snapshot };
}

test('高优先级任务到达后抢占低优先级任务', () => {
  const { scheduler, snapshot } = run({
    quantum: 3,
    tasks: [
      { id: 'LOW', priority: 1, duration: 6, arrival: 0 },
      { id: 'HIGH', priority: 9, duration: 2, arrival: 1 }
    ]
  });
  const preemptedEvent = scheduler.events.find((event) => event.type === 'PREEMPTED');
  assert.equal(preemptedEvent?.taskId, 'LOW');
  assert.equal(preemptedEvent.detail.by, 'HIGH');
  assert.equal(snapshot.tasks.find((task) => task.id === 'HIGH').state, TASK_STATE.COMPLETED);
  assert.equal(snapshot.stats.preemptions, 1);
});

test('依赖未完成时不执行，全部完成后级联就绪', () => {
  const scheduler = new Scheduler({
    tasks: [
      { id: 'A', duration: 2 },
      { id: 'B', duration: 2 },
      { id: 'C', duration: 1, deps: ['A', 'B'] }
    ]
  });
  for (let tick = 0; tick < 3; tick += 1) scheduler.tick();
  assert.notEqual(scheduler.cpuTaskId, 'C');
  const finished = run({
    tasks: [
      { id: 'A', duration: 2 },
      { id: 'B', duration: 2 },
      { id: 'C', duration: 1, deps: ['A', 'B'] }
    ]
  }).snapshot;
  assert.equal(finished.tasks.find((task) => task.id === 'C').state, TASK_STATE.COMPLETED);
});

test('同优先级任务按 vruntime 与时间片公平轮转', () => {
  const { snapshot } = run({
    quantum: 1,
    tasks: [
      { id: 'A', priority: 5, duration: 3 },
      { id: 'B', priority: 5, duration: 3 }
    ]
  });
  const cpuOrder = snapshot.gantt.map((slice) => slice.taskId).join('');
  assert.match(cpuOrder, /ABABAB/);
  assert.ok(snapshot.stats.timeslices >= 4);
});

test('资源等待触发优先级继承以消除优先级反转', () => {
  const scheduler = new Scheduler({
    quantum: 4,
    tasks: [
      { id: 'LOW', priority: 1, duration: 5, locks: ['R1'] },
      { id: 'MID', priority: 5, duration: 4, arrival: 1 },
      { id: 'HIGH', priority: 9, duration: 2, arrival: 1, locks: ['R1'] }
    ]
  });
  scheduler.tick();
  scheduler.tick();
  const low = scheduler.tasks.get('LOW');
  assert.equal(low.effectivePriority, 9);
  assert.ok(low.priorityInheritors.includes('HIGH'));
  assert.ok(scheduler.events.some((event) => event.type === 'PRIORITY_INHERITED' && event.taskId === 'LOW'));
  run({
    quantum: 4,
    tasks: [
      { id: 'LOW', priority: 1, duration: 5, locks: ['R1'] },
      { id: 'MID', priority: 5, duration: 4, arrival: 1 },
      { id: 'HIGH', priority: 9, duration: 2, arrival: 1, locks: ['R1'] }
    ]
  });
});

test('检测资源环并解除死锁，下游任务进入异常链路', () => {
  const { snapshot } = run({
    quantum: 2,
    tasks: [
      { id: 'A', priority: 3, duration: 5, arrival: 0, lockRequests: [{ lock: 'R1', at: 0 }, { lock: 'R2', at: 3 }] },
      { id: 'B', priority: 3, duration: 5, arrival: 0, lockRequests: [{ lock: 'R2', at: 0 }, { lock: 'R1', at: 3 }] },
      { id: 'C', priority: 5, duration: 1, deps: ['A', 'B'] }
    ]
  });
  assert.equal(snapshot.deadlockCycles.length > 0, true);
  const states = new Map(snapshot.tasks.map((task) => [task.id, task.state]));
  assert.ok([states.get('A'), states.get('B')].includes(TASK_STATE.DEADLOCKED));
  assert.equal(states.get('C'), TASK_STATE.SKIPPED);
  assert.ok(snapshot.events.some((event) => event.type === 'DEADLOCK_DETECTED'));
});

test('超时后按配置重试，最终失败时级联跳过', () => {
  const { snapshot } = run({
    retryDelay: 1,
    tasks: [
      { id: 'T', priority: 5, duration: 4, timeout: 1, retries: 1 },
      { id: 'D', priority: 5, duration: 1, deps: ['T'] }
    ]
  });
  assert.equal(snapshot.stats.timeouts >= 2, true);
  assert.equal(snapshot.stats.retried, 1);
  assert.equal(snapshot.tasks.find((task) => task.id === 'T').state, TASK_STATE.FAILED);
  assert.equal(snapshot.tasks.find((task) => task.id === 'D').state, TASK_STATE.SKIPPED);
});

test('所有内置场景均可在有限 tick 内终止', () => {
  for (const scenario of scenarios) {
    const result = run(structuredClone(scenario.config), 120);
    assert.equal(result.snapshot.finished, true, scenario.id);
    assert.equal(result.snapshot.tasks.every((task) => task.state !== TASK_STATE.RUNNING), true, scenario.id);
  }
});

test('快照包含每 tick 状态轨，Canvas 可准确还原任务状态', () => {
  const { snapshot } = run({
    quantum: 1,
    tasks: [
      { id: 'A', priority: 5, duration: 2 },
      { id: 'B', priority: 5, duration: 2 }
    ]
  });
  assert.equal(snapshot.statusRows.length >= snapshot.time, true);
  assert.equal(snapshot.statusRows[0].states.A, TASK_STATE.PENDING);
  assert.equal(snapshot.gantt.every((slice) => slice.end > slice.start), true);
});

test('初始依赖图存在环时拒绝创建调度器', () => {
  assert.throws(() => new Scheduler({
    tasks: [
      { id: 'A', deps: ['B'], duration: 1 },
      { id: 'B', deps: ['A'], duration: 1 }
    ]
  }), /依赖 DAG 不允许有环/);
});
