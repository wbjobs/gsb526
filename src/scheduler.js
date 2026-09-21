export const TASK_STATE = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  PREEMPTED: 'PREEMPTED',
  BLOCKED: 'BLOCKED',
  WAITING_RETRY: 'WAITING_RETRY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DEADLOCKED: 'DEADLOCKED',
  SKIPPED: 'SKIPPED'
});

const TERMINAL_STATES = new Set([
  TASK_STATE.COMPLETED,
  TASK_STATE.FAILED,
  TASK_STATE.DEADLOCKED,
  TASK_STATE.SKIPPED
]);

export class SchedulerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.details = details;
  }
}

export class Scheduler {
  constructor(config = {}) {
    this.tasks = new Map();
    this.taskOrder = [];
    this.time = 0;
    this.cpuTaskId = null;
    this.quantum = Math.max(1, config.quantum ?? 2);
    this.tickMs = Math.max(1, config.tickMs ?? 100);
    this.retryDelay = Math.max(0, config.retryDelay ?? 2);
    this.lockOwners = new Map();
    this.lockWaiters = new Map();
    this.events = [];
    this.gantt = [];
    this.statusRows = [];
    this.seq = 0;
    this.finished = false;
    this.deadlockCycles = [];
    this.stats = {
      completed: 0,
      failed: 0,
      deadlocked: 0,
      skipped: 0,
      retried: 0,
      preemptions: 0,
      timeslices: 0,
      timeouts: 0
    };
    this.importTasks(config.tasks ?? []);
  }

  importTasks(rawTasks) {
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new SchedulerError('至少需要一个任务');
    }
    this.tasks = new Map();
    this.taskOrder = [];
    const seen = new Set();

    for (const raw of rawTasks) {
      if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
        throw new SchedulerError('任务 id 必须是非空字符串', { raw });
      }
      const id = raw.id.trim();
      if (seen.has(id)) {
        throw new SchedulerError(`任务 id 重复: ${id}`, { id });
      }
      seen.add(id);
      const duration = Number(raw.duration ?? 1);
      if (!Number.isInteger(duration) || duration <= 0) {
        throw new SchedulerError(`任务 ${id} 的 duration 必须是正整数`, { id });
      }
      const basePriority = Number(raw.priority ?? 0);
      if (!Number.isInteger(basePriority) || basePriority < 0 || basePriority > 99) {
        throw new SchedulerError(`任务 ${id} 的 priority 必须是 0..99 的整数`, { id });
      }
      const timeout = Number(raw.timeout ?? duration + 1);
      if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new SchedulerError(`任务 ${id} 的 timeout 必须是正整数`, { id });
      }
      const retries = Number(raw.retries ?? 0);
      if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new SchedulerError(`任务 ${id} 的 retries 必须是 0..10 的整数`, { id });
      }
      const arrival = Number(raw.arrival ?? 0);
      if (!Number.isInteger(arrival) || arrival < 0) {
        throw new SchedulerError(`任务 ${id} 的 arrival 必须是非负整数`, { id });
      }
      const failAt = raw.failAt == null ? null : Number(raw.failAt);
      if (failAt != null && (!Number.isInteger(failAt) || failAt <= 0 || failAt >= duration)) {
        throw new SchedulerError(`任务 ${id} 的 failAt 必须位于 1..duration-1`, { id });
      }
      const deps = [...new Set((raw.deps ?? []).map(String))];
      const lockRequests = normalizeLockRequests(raw.lockRequests ?? raw.locks ?? []);
      const locks = [...new Set(lockRequests.map((item) => item.lock))];
      const task = {
        id,
        label: String(raw.label ?? id),
        deps,
        locks,
        lockRequests,
        duration,
        remaining: duration,
        priority: basePriority,
        basePriority,
        effectivePriority: basePriority,
        arrival,
        timeout,
        retries,
        failAt,
        state: TASK_STATE.PENDING,
        attempt: 0,
        executed: 0,
        attemptExecuted: 0,
        quantumUsed: 0,
        vruntime: 0,
        waitingFor: [],
        heldLocks: [],
        retryAt: null,
        lastReason: null,
        x: Number(raw.x ?? 0),
        y: Number(raw.y ?? 0),
        history: [{ time: 0, state: TASK_STATE.PENDING, reason: '已创建' }]
      };
      this.tasks.set(id, task);
      this.taskOrder.push(id);
    }

    for (const task of this.tasks.values()) {
      for (const dep of task.deps) {
        if (!this.tasks.has(dep)) {
          throw new SchedulerError(`任务 ${task.id} 依赖不存在的任务 ${dep}`, { id: task.id, dep });
        }
      }
      for (const lock of task.locks) {
        this.lockWaiters.set(lock, []);
      }
    }
    const cycles = findDependencyCycles(this.tasks);
    if (cycles.length > 0) {
      throw new SchedulerError('依赖 DAG 不允许有环', { cycles });
    }
    this.events = [this.makeEvent('CONFIG_READY', null, { taskCount: this.tasks.size, quantum: this.quantum })];
    this.captureStatusRow();
  }

  reset() {
    return new Scheduler({
      tasks: this.exportTaskConfig(),
      quantum: this.quantum,
      tickMs: this.tickMs,
      retryDelay: this.retryDelay
    });
  }

  exportTaskConfig() {
    return this.taskOrder.map((id) => {
      const task = this.tasks.get(id);
      return {
        id: task.id,
        label: task.label,
        deps: task.deps,
        locks: task.lockRequests,
        duration: task.duration,
        priority: task.basePriority,
        arrival: task.arrival,
        timeout: task.timeout,
        retries: task.retries,
        failAt: task.failAt,
        x: task.x,
        y: task.y
      };
    });
  }

  makeEvent(type, taskId, detail = {}, severity = 'info') {
    this.seq += 1;
    const event = {
      id: this.seq,
      time: this.time,
      type,
      taskId,
      severity,
      detail,
      message: formatEvent(type, taskId, detail)
    };
    this.events.push(event);
    return event;
  }

  setState(task, state, reason, extra = {}) {
    task.state = state;
    task.lastReason = reason;
    task.history.push({ time: this.time, state, reason, ...extra });
    if (state === TASK_STATE.COMPLETED) this.stats.completed += 1;
    if (state === TASK_STATE.FAILED) this.stats.failed += 1;
    if (state === TASK_STATE.DEADLOCKED) this.stats.deadlocked += 1;
    if (state === TASK_STATE.SKIPPED) this.stats.skipped += 1;
  }

  tick() {
    if (this.finished) return this.snapshot();
    this.processStateTransitions();
    this.refreshPriorityInheritance();

    const running = this.cpuTaskId ? this.tasks.get(this.cpuTaskId) : null;
    if (running) {
      const challenger = this.chooseReadyTask(running.id);
      if (challenger && challenger.effectivePriority > running.effectivePriority) {
        this.preempt(running, challenger, '高优先级任务抢占 CPU');
      }
    }

    if (!this.cpuTaskId) {
      const candidate = this.chooseReadyTask();
      if (candidate) this.dispatch(candidate);
    }

    if (this.cpuTaskId) {
      this.executeRunningTask();
    } else {
      this.time += 1;
      this.makeEvent('CPU_IDLE', null, {});
    }

    this.processStateTransitions();
    this.refreshPriorityInheritance();
    this.resolveDeadlocks();
    this.captureStatusRow();
    if (!this.cpuTaskId && !this.finished) {
      const candidate = this.chooseReadyTask();
      if (candidate) this.dispatch(candidate);
    }
    this.finished = this.isComplete();
    if (this.finished) {
      this.makeEvent('SIMULATION_DONE', null, { time: this.time, stats: { ...this.stats } }, 'success');
    }
    return this.snapshot();
  }

  processStateTransitions() {
    for (const id of this.taskOrder) {
      const task = this.tasks.get(id);
      if (task.state === TASK_STATE.WAITING_RETRY && task.retryAt !== null && task.retryAt <= this.time) {
        task.remaining = task.duration;
        task.attemptExecuted = 0;
        task.quantumUsed = 0;
        task.vruntime = 0;
        task.waitingFor = [];
        task.heldLocks = [];
        task.retryAt = null;
        task.state = TASK_STATE.READY;
        task.lastReason = '重试等待结束';
        task.history.push({ time: this.time, state: TASK_STATE.READY, reason: `第 ${task.attempt} 次尝试就绪` });
        this.makeEvent('RETRY_READY', task.id, { attempt: task.attempt });
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of this.taskOrder) {
        const task = this.tasks.get(id);
        if (task.state !== TASK_STATE.PENDING || task.arrival > this.time) continue;
        const dependencyStates = task.deps.map((dep) => this.tasks.get(dep).state);
        if (dependencyStates.some((state) => isFailureState(state))) {
          const failedDeps = task.deps.filter((dep) => isFailureState(this.tasks.get(dep).state));
          this.setState(task, TASK_STATE.SKIPPED, '上游终态失败', { failedDeps });
          this.makeEvent('DEPENDENCY_SKIPPED', task.id, { failedDeps }, 'warning');
          changed = true;
          continue;
        }
        if (dependencyStates.every((state) => state === TASK_STATE.COMPLETED)) {
          task.state = TASK_STATE.READY;
          task.lastReason = '依赖已完成';
          task.history.push({ time: this.time, state: TASK_STATE.READY, reason: '依赖已完成' });
          this.makeEvent('TASK_READY', task.id, { deps: task.deps });
          changed = true;
        }
      }
    }
  }

  chooseReadyTask(excludeId = null) {
    const candidates = this.taskOrder
      .map((id) => this.tasks.get(id))
      .filter((task) => {
        if (task.id === excludeId) return false;
        if (task.arrival > this.time) return false;
        return task.state === TASK_STATE.READY || task.state === TASK_STATE.PREEMPTED;
      });
    candidates.sort((a, b) => {
      if (b.effectivePriority !== a.effectivePriority) return b.effectivePriority - a.effectivePriority;
      if (a.vruntime !== b.vruntime) return a.vruntime - b.vruntime;
      if (a.arrival !== b.arrival) return a.arrival - b.arrival;
      return a.id.localeCompare(b.id);
    });
    return candidates[0] ?? null;
  }

  preempt(task, challenger, reason) {
    this.endGanttSlice(task.id, this.time, 'preempt');
    task.state = TASK_STATE.PREEMPTED;
    task.quantumUsed = 0;
    task.lastReason = reason;
    task.history.push({ time: this.time, state: TASK_STATE.PREEMPTED, reason, by: challenger.id });
    this.cpuTaskId = null;
    this.stats.preemptions += 1;
    this.makeEvent('PREEMPTED', task.id, { by: challenger.id, reason }, 'warning');
  }

  dispatch(task) {
    if (task.attempt === 0) task.attempt = 1;
    task.quantumUsed = 0;
    task.waitingFor = [];

    if (!this.requestDueLocks(task)) return false;

    task.state = TASK_STATE.RUNNING;
    task.lastReason = '获得 CPU';
    task.history.push({ time: this.time, state: TASK_STATE.RUNNING, reason: '获得 CPU', attempt: task.attempt });
    this.cpuTaskId = task.id;
    this.makeEvent('DISPATCHED', task.id, { attempt: task.attempt, priority: task.effectivePriority });
    return true;
  }

  requestDueLocks(task) {
    for (const request of task.lockRequests.filter((item) => item.at <= task.attemptExecuted)) {
      const lock = request.lock;
      const ownerId = this.lockOwners.get(lock);
      if (task.heldLocks.includes(lock) && ownerId === task.id) continue;
      if (ownerId && ownerId !== task.id) {
        task.state = TASK_STATE.BLOCKED;
        task.waitingFor = [lock];
        task.quantumUsed = 0;
        task.lastReason = `等待资源 ${lock}`;
        task.history.push({ time: this.time, state: TASK_STATE.BLOCKED, reason: task.lastReason, owner: ownerId, lock });
        this.enqueueWaiter(lock, task.id);
        if (this.cpuTaskId === task.id) this.cpuTaskId = null;
        this.makeEvent('LOCK_BLOCKED', task.id, { lock, owner: ownerId, at: request.at }, 'warning');
        return false;
      }
      this.lockOwners.set(lock, task.id);
      task.heldLocks.push(lock);
      this.makeEvent('LOCK_ACQUIRED', task.id, { lock, at: request.at });
    }
    task.waitingFor = [];
    return true;
  }

  enqueueWaiter(lock, taskId) {
    const waiters = this.lockWaiters.get(lock) ?? [];
    if (!waiters.includes(taskId)) waiters.push(taskId);
    this.lockWaiters.set(lock, waiters);
  }

  executeRunningTask() {
    const task = this.tasks.get(this.cpuTaskId);
    const start = this.time;
    if (!this.requestDueLocks(task)) {
      return;
    }
    task.remaining -= 1;
    task.executed += 1;
    task.attemptExecuted += 1;
    task.quantumUsed += 1;
    task.vruntime += 1;
    this.time = start + 1;
    this.gantt.push({ taskId: task.id, start, end: this.time, reason: 'run' });

    if (task.attempt === 1 && task.failAt !== null && task.attemptExecuted === task.failAt) {
      this.finishAttempt(task, 'CPU_EXCEPTION', '模拟 CPU 异常');
      return;
    }
    if (task.remaining > 0 && task.attemptExecuted >= task.timeout) {
      this.stats.timeouts += 1;
      this.finishAttempt(task, 'TIMEOUT', `执行超过 ${task.timeout} tick 超时`);
      return;
    }
    if (task.remaining === 0) {
      this.completeTask(task);
      return;
    }
    if (task.quantumUsed >= this.quantum) {
      const challenger = this.chooseReadyTask(task.id);
      if (challenger) {
        this.markLastGanttSlice(task.id, 'timeslice');
        task.state = TASK_STATE.PREEMPTED;
        task.quantumUsed = 0;
        task.lastReason = '时间片耗尽';
        task.history.push({ time: this.time, state: TASK_STATE.PREEMPTED, reason: '时间片耗尽', by: challenger.id });
        this.cpuTaskId = null;
        this.stats.timeslices += 1;
        this.makeEvent('QUANTUM_EXPIRED', task.id, { by: challenger.id, quantum: this.quantum }, 'warning');
      } else {
        task.quantumUsed = 0;
        this.makeEvent('QUANTUM_RENEWED', task.id, { quantum: this.quantum });
      }
    }
  }

  markLastGanttSlice(taskId, reason) {
    for (let index = this.gantt.length - 1; index >= 0; index -= 1) {
      if (this.gantt[index].taskId === taskId) {
        this.gantt[index].reason = reason;
        return;
      }
    }
  }

  endGanttSlice(taskId, time, reason) {
    const slice = [...this.gantt].reverse().find((item) => item.taskId === taskId && item.end === time);
    if (slice) slice.reason = reason;
  }

  captureStatusRow() {
    const last = this.statusRows[this.statusRows.length - 1];
    if (last && last.time === this.time) return;
    const states = {};
    for (const id of this.taskOrder) states[id] = this.tasks.get(id).state;
    this.statusRows.push({ time: this.time, states });
  }

  completeTask(task) {
    this.cpuTaskId = null;
    this.releaseLocks(task);
    this.setState(task, TASK_STATE.COMPLETED, '正常完成', { attempt: task.attempt });
    this.makeEvent('TASK_COMPLETED', task.id, { attempt: task.attempt, time: this.time }, 'success');
  }

  finishAttempt(task, error, reason) {
    this.cpuTaskId = null;
    this.releaseLocks(task);
    const maxAttempts = task.retries + 1;
    if (task.attempt <= task.retries) {
      task.attempt += 1;
      task.retryAt = this.time + this.retryDelay;
      task.waitingFor = [];
      task.state = TASK_STATE.WAITING_RETRY;
      task.lastReason = reason;
      task.history.push({ time: this.time, state: TASK_STATE.WAITING_RETRY, reason, retryAt: task.retryAt });
      this.stats.retried += 1;
      this.makeEvent('RETRY_SCHEDULED', task.id, {
        error,
        reason,
        failedAttempt: task.attempt - 1,
        nextAttempt: task.attempt,
        maxAttempts,
        retryAt: task.retryAt
      }, 'warning');
    } else {
      this.setState(task, TASK_STATE.FAILED, reason, { error, attempt: task.attempt, maxAttempts });
      this.cascadeSkipped(task.id);
      this.makeEvent('TASK_FAILED', task.id, {
        error,
        reason,
        attempt: task.attempt,
        maxAttempts,
        exceptionChain: buildExceptionChain(this.tasks, task.id)
      }, 'danger');
    }
  }

  releaseLocks(releasingTask) {
    const released = [];
    for (const lock of releasingTask.heldLocks) {
      if (this.lockOwners.get(lock) === releasingTask.id) {
        this.lockOwners.delete(lock);
        released.push(lock);
      }
    }
    releasingTask.heldLocks = [];

    for (const [lock, waiters] of this.lockWaiters) {
      this.lockWaiters.set(lock, waiters.filter((id) => id !== releasingTask.id));
    }

    for (const lock of released) {
      this.makeEvent('LOCK_RELEASED', releasingTask.id, { lock });
      for (const id of this.taskOrder) {
        const task = this.tasks.get(id);
        const waitsForLock = task.state === TASK_STATE.BLOCKED && task.waitingFor.includes(lock);
        if (waitsForLock && !this.lockOwners.has(lock)) {
          task.state = TASK_STATE.READY;
          task.waitingFor = [];
          task.lastReason = `资源 ${lock} 已释放`;
          task.history.push({ time: this.time, state: TASK_STATE.READY, reason: task.lastReason, lock });
          this.makeEvent('LOCK_READY', task.id, { lock });
        }
      }
      const remainingWaiters = (this.lockWaiters.get(lock) ?? []).filter((waiterId) => {
        const waiter = this.tasks.get(waiterId);
        return waiter.state === TASK_STATE.BLOCKED && waiter.waitingFor.includes(lock);
      });
      this.lockWaiters.set(lock, remainingWaiters);
    }
  }

  cascadeSkipped(rootId) {
    const reverseDeps = new Map();
    for (const id of this.taskOrder) reverseDeps.set(id, []);
    for (const id of this.taskOrder) {
      const task = this.tasks.get(id);
      for (const dep of task.deps) reverseDeps.get(dep)?.push(id);
    }

    const queue = [rootId];
    const visited = new Set();
    while (queue.length > 0) {
      const currentId = queue.shift();
      for (const dependentId of reverseDeps.get(currentId) ?? []) {
        if (visited.has(dependentId)) continue;
        visited.add(dependentId);
        const dependent = this.tasks.get(dependentId);
        if (!TERMINAL_STATES.has(dependent.state)) {
          if (dependent.id === this.cpuTaskId) this.cpuTaskId = null;
          this.releaseLocks(dependent);
          this.setState(dependent, TASK_STATE.SKIPPED, `上游 ${currentId} 失败`, { root: rootId });
          this.makeEvent('EXCEPTION_CASCADE', dependent.id, { upstream: currentId, root: rootId }, 'danger');
        }
        queue.push(dependentId);
      }
    }
  }

  buildWaitGraph() {
    const graph = new Map(this.taskOrder.map((id) => [id, new Set()]));
    const addWait = (fromId, toId, reason, resource = null) => {
      if (fromId !== toId && this.tasks.has(toId)) {
        const edges = graph.get(fromId);
        const key = `${toId}:${reason}:${resource ?? ''}`;
        if (edges && !edges.has(key)) edges.add({ task: toId, reason, resource, key });
      }
    };

    for (const task of this.tasks.values()) {
      if (TERMINAL_STATES.has(task.state) || task.state === TASK_STATE.WAITING_RETRY) continue;
      for (const dep of task.deps) {
        const dependency = this.tasks.get(dep);
        if (!TERMINAL_STATES.has(dependency.state)) {
          addWait(task.id, dep, 'dependency');
        }
      }
      const mayHoldLocks = task.state === TASK_STATE.RUNNING ||
        task.state === TASK_STATE.PREEMPTED ||
        task.state === TASK_STATE.BLOCKED ||
        task.heldLocks.length > 0;
      if (!mayHoldLocks) continue;
      for (const request of task.lockRequests.filter((item) => item.at <= task.attemptExecuted)) {
        const lock = request.lock;
        const ownerId = this.lockOwners.get(lock);
        if (ownerId && ownerId !== task.id && !task.heldLocks.includes(lock)) {
          addWait(task.id, ownerId, 'resource', lock);
        }
      }
      if (task.state === TASK_STATE.BLOCKED) {
        for (const lock of task.waitingFor) {
          const ownerId = this.lockOwners.get(lock);
          if (ownerId) addWait(task.id, ownerId, 'resource', lock);
        }
      }
    }
    return graph;
  }

  refreshPriorityInheritance() {
    const graph = this.buildWaitGraph();
    const reverseGraph = new Map(this.taskOrder.map((id) => [id, []]));
    for (const [fromId, edges] of graph) {
      for (const edge of edges) {
        if (edge.reason === 'resource') reverseGraph.get(edge.task)?.push(fromId);
      }
    }
    for (const targetId of this.taskOrder) {
      const target = this.tasks.get(targetId);
      let inherited = target.basePriority;
      const inheritors = [];
      const stack = [targetId];
      const seen = new Set([targetId]);
      while (stack.length > 0) {
        const currentId = stack.pop();
        for (const waiterId of reverseGraph.get(currentId) ?? []) {
          if (!seen.has(waiterId)) {
            seen.add(waiterId);
            stack.push(waiterId);
            const waiter = this.tasks.get(waiterId);
            inherited = Math.max(inherited, waiter.basePriority);
            if (waiter.basePriority > target.basePriority) inheritors.push(waiter.id);
          }
        }
      }
      const previous = target.effectivePriority;
      target.effectivePriority = inherited;
      target.priorityInheritors = [...new Set(inheritors)];
      if (previous !== inherited) {
        target.effectivePriority = inherited;
        this.makeEvent(
          inherited > previous ? 'PRIORITY_INHERITED' : 'PRIORITY_RESTORED',
          target.id,
          { from: previous, to: inherited, base: target.basePriority, inheritors: target.priorityInheritors },
          inherited > previous ? 'warning' : 'info'
        );
      }
    }
  }

  resolveDeadlocks() {
    const graph = this.buildWaitGraph();
    const cycles = findResourceCycles(graph);
    if (cycles.length === 0) return;

    const cycleKey = cycles.map((cycle) => [...cycle].sort().join(',')).sort()[0];
    const cycle = cycles.find((item) => [...item].sort().join(',') === cycleKey);
    const cycleSet = new Set(cycle);
    this.deadlockCycles.push({ time: this.time, cycle: [...cycle] });
    this.makeEvent('DEADLOCK_DETECTED', null, { cycle: [...cycle] }, 'danger');

    const victim = [...cycleSet]
      .map((id) => this.tasks.get(id))
      .sort((a, b) => {
        if (a.effectivePriority !== b.effectivePriority) return a.effectivePriority - b.effectivePriority;
        return b.attemptExecuted - a.attemptExecuted;
      })[0];

    if (victim.id === this.cpuTaskId) this.cpuTaskId = null;
    this.releaseLocks(victim);
    this.setState(victim, TASK_STATE.DEADLOCKED, '资源等待环中止低优先级受害者', { cycle: [...cycleSet] });
    this.cascadeSkipped(victim.id);
    this.makeEvent('DEADLOCK_VICTIM', victim.id, { cycle: [...cycleSet] }, 'danger');
  }

  isComplete() {
    return this.taskOrder.every((id) => TERMINAL_STATES.has(this.tasks.get(id).state));
  }

  snapshot() {
    const graph = this.buildWaitGraph();
    const waitEdges = [];
    for (const [fromId, edges] of graph) {
      for (const edge of edges) waitEdges.push({ from: fromId, to: edge.task, reason: edge.reason, resource: edge.resource });
    }

    return {
      time: this.time,
      quantum: this.quantum,
      tickMs: this.tickMs,
      retryDelay: this.retryDelay,
      cpuTaskId: this.cpuTaskId,
      finished: this.finished,
      taskOrder: [...this.taskOrder],
      tasks: this.taskOrder.map((id) => structuredClone(this.tasks.get(id))),
      resources: [...new Set(this.taskOrder.flatMap((id) => this.tasks.get(id).locks))].map((lock) => ({
        id: lock,
        owner: this.lockOwners.get(lock) ?? null,
        waiters: [...(this.lockWaiters.get(lock) ?? [])]
      })),
      waitEdges,
      gantt: this.gantt.map((slice) => ({ ...slice })),
      statusRows: this.statusRows.map((row) => ({ ...row, states: { ...row.states } })),
      events: this.events.map((event) => ({ ...event })),
      deadlockCycles: this.deadlockCycles.map((item) => ({ ...item, cycle: [...item.cycle] })),
      stats: { ...this.stats }
    };
  }
}

function isFailureState(state) {
  return state === TASK_STATE.FAILED || state === TASK_STATE.DEADLOCKED || state === TASK_STATE.SKIPPED;
}

function normalizeLockRequests(value) {
  if (!Array.isArray(value)) throw new SchedulerError('lockRequests 必须是数组');
  return value.map((item, index) => {
    if (typeof item === 'string') return { lock: item, at: 0 };
    if (!item || typeof item.lock !== 'string' || !item.lock.trim()) {
      throw new SchedulerError(`第 ${index + 1} 个资源申请无效`);
    }
    const at = Number(item.at ?? 0);
    if (!Number.isInteger(at) || at < 0) {
      throw new SchedulerError(`资源 ${item.lock} 的申请时刻 at 必须是非负整数`);
    }
    return { lock: item.lock.trim(), at };
  }).sort((a, b) => a.at - b.at || a.lock.localeCompare(b.lock));
}

function findDependencyCycles(tasks) {
  const graph = new Map([...tasks.keys()].map((id) => [id, tasks.get(id).deps]));
  return findStronglyConnectedCycles(graph);
}

function findResourceCycles(graph) {
  const simpleGraph = new Map();
  for (const [id, edges] of graph) {
    simpleGraph.set(id, [...edges].filter((edge) => edge.reason === 'resource').map((edge) => edge.task));
  }
  return findStronglyConnectedCycles(simpleGraph);
}

function findStronglyConnectedCycles(graph) {
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let index = 0;

  const visit = (id) => {
    indices.set(id, index);
    lowLinks.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const next of graph.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(id, Math.min(lowLinks.get(id), indices.get(next)));
      }
    }

    if (lowLinks.get(id) === indices.get(id)) {
      const component = [];
      let current = null;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== id);
      if (component.length > 1 || graph.get(id)?.includes(id)) cycles.push(component);
    }
  };

  for (const id of graph.keys()) {
    if (!indices.has(id)) visit(id);
  }
  return cycles;
}

function buildExceptionChain(tasks, failedId) {
  const chain = [];
  const visited = new Set();
  const walk = (id, depth) => {
    if (visited.has(id)) return;
    visited.add(id);
    const task = tasks.get(id);
    chain.push({ id: task.id, state: task.state, reason: task.lastReason, depth });
    for (const candidate of tasks.values()) {
      if (candidate.deps.includes(id) && isFailureState(candidate.state)) walk(candidate.id, depth + 1);
    }
  };
  walk(failedId, 0);
  return chain;
}

function formatEvent(type, taskId, detail) {
  const name = taskId ? `[${taskId}]` : '[scheduler]';
  const messages = {
    CONFIG_READY: () => `${name} 场景已加载：${detail.taskCount} 个任务，时间片 ${detail.quantum}`,
    TASK_READY: () => `${name} 依赖完成，进入就绪队列`,
    DISPATCHED: () => `${name} 调度运行，第 ${detail.attempt} 次尝试，有效优先级 ${detail.priority}`,
    PREEMPTED: () => `${name} 被 ${detail.by} 抢占：${detail.reason}`,
    QUANTUM_EXPIRED: () => `${name} 时间片耗尽，切换给 ${detail.by}`,
    QUANTUM_RENEWED: () => `${name} 时间片刷新，没有同优先级竞争者`,
    LOCK_ACQUIRED: () => `${name} 获得资源 ${detail.lock}`,
    LOCK_BLOCKED: () => `${name} 等待资源 ${detail.lock}，持有者 ${detail.owner}`,
    LOCK_RELEASED: () => `${name} 释放资源 ${detail.lock}`,
    LOCK_READY: () => `${name} 等待的资源 ${detail.lock} 已可用`,
    TASK_COMPLETED: () => `${name} 在 tick ${detail.time} 正常完成`,
    RETRY_SCHEDULED: () => `${name} ${detail.reason}，将在 tick ${detail.retryAt} 进行第 ${detail.nextAttempt}/${detail.maxAttempts} 次尝试`,
    RETRY_READY: () => `${name} 第 ${detail.attempt} 次尝试重新就绪`,
    TASK_FAILED: () => `${name} ${detail.reason}，第 ${detail.attempt}/${detail.maxAttempts} 次后失败`,
    DEADLOCK_DETECTED: () => `${name} 检测到资源等待环：${detail.cycle.join(' → ')}`,
    DEADLOCK_VICTIM: () => `${name} 被选为死锁解除受害者`,
    DEPENDENCY_SKIPPED: () => `${name} 因上游失败而跳过：${detail.failedDeps.join(', ')}`,
    EXCEPTION_CASCADE: () => `${name} 跟随上游 ${detail.upstream} 失败而跳过`,
    PRIORITY_INHERITED: () => `${name} 继承优先级 ${detail.from} → ${detail.to}`,
    PRIORITY_RESTORED: () => `${name} 恢复有效优先级 ${detail.from} → ${detail.to}`,
    CPU_IDLE: () => '[scheduler] CPU 空闲一个 tick',
    SIMULATION_DONE: () => `[scheduler] 调度完成，总耗时 ${detail.time} tick`
  };
  return messages[type] ? messages[type]() : `${name} ${type}`;
}
