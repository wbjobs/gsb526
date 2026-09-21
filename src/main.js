import { scenarios } from './scenarios.js';
import { renderAll, stateColor } from './canvas-view.js';

const elements = {
  scenario: document.querySelector('#scenarioSelect'),
  reset: document.querySelector('#resetBtn'),
  step: document.querySelector('#stepBtn'),
  play: document.querySelector('#playBtn'),
  speed: document.querySelector('#speedRange'),
  speedValue: document.querySelector('#speedValue'),
  file: document.querySelector('#scenarioFile'),
  tick: document.querySelector('#tickValue'),
  completed: document.querySelector('#completedCount'),
  active: document.querySelector('#activeCount'),
  blocked: document.querySelector('#blockedCount'),
  failed: document.querySelector('#failedCount'),
  tasks: document.querySelector('#taskTable'),
  events: document.querySelector('#eventLog'),
  dag: document.querySelector('#dagCanvas'),
  gantt: document.querySelector('#ganttCanvas')
};

let snapshot = null;
let worker = null;
let timer = null;
let workerReady = false;

for (const scenario of scenarios) {
  const option = document.createElement('option');
  option.value = scenario.id;
  option.textContent = scenario.name;
  elements.scenario.append(option);
}

function post(message) {
  if (!worker || !workerReady) return;
  worker.postMessage(message);
}

function initWorker(config) {
  if (worker) worker.terminate();
  stopPlayback();
  workerReady = false;
  snapshot = null;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    if (event.data.type === 'snapshot') {
      workerReady = true;
      snapshot = event.data.snapshot;
      renderSnapshot();
      if (snapshot.finished) stopPlayback();
    }
    if (event.data.type === 'error') {
      stopPlayback();
      alert(`${event.data.error.message}\n${JSON.stringify(event.data.error.details ?? {}, null, 2)}`);
    }
  };
  post({ type: 'init', config });
}

function resetCurrentScenario() {
  stopPlayback();
  workerReady = false;
  worker.postMessage({ type: 'reset' });
  workerReady = true;
}

function stopPlayback() {
  if (timer) window.clearInterval(timer);
  timer = null;
  elements.play.textContent = '播放';
}

function startPlayback() {
  if (!snapshot || snapshot.finished) {
    if (!snapshot) return;
    resetCurrentScenario();
  }
  timer = window.setInterval(() => post({ type: 'tick' }), Number(elements.speed.value));
  elements.play.textContent = '暂停';
}

function renderSnapshot() {
  elements.tick.textContent = snapshot.time;
  const activeCount = snapshot.tasks.filter((task) => ['READY', 'RUNNING', 'PREEMPTED', 'BLOCKED'].includes(task.state)).length;
  const blockedCount = snapshot.tasks.filter((task) => ['BLOCKED', 'WAITING_RETRY', 'PENDING'].includes(task.state)).length;
  const failedCount = snapshot.tasks.filter((task) => ['FAILED', 'DEADLOCKED', 'SKIPPED'].includes(task.state)).length;
  elements.completed.textContent = snapshot.stats.completed;
  elements.active.textContent = activeCount;
  elements.blocked.textContent = `${blockedCount} / ${snapshot.stats.deadlocked}`;
  elements.failed.textContent = `${failedCount}（${snapshot.stats.skipped} 跳过）`;
  renderTaskTable();
  renderEvents();
  renderAll({ dag: elements.dag, gantt: elements.gantt }, snapshot);
}

function renderTaskTable() {
  const resourceOwner = new Map(snapshot.resources.map((resource) => [resource.id, resource.owner]));
  const rows = snapshot.tasks.map((task) => {
    const held = task.heldLocks.join(', ') || '—';
    const waiting = task.waitingFor.length > 0
      ? `${task.waitingFor.join(', ')}${resourceOwner.get(task.waitingFor[0]) ? ` ← ${resourceOwner.get(task.waitingFor[0])}` : ''}`
      : '—';
    return `
      <div class="task-row ${task.id === snapshot.cpuTaskId ? 'running' : ''}">
        <span class="state-dot" style="--dot:${stateColor(task.state)}"></span>
        <strong>${task.id}</strong>
        <span class="state-name">${task.state}</span>
        <span>P ${task.effectivePriority}${task.effectivePriority !== task.basePriority ? ` <em>base ${task.basePriority}</em>` : ''}</span>
        <span>尝试 ${task.attempt}/${task.retries + 1}</span>
        <span>进度 ${task.duration - task.remaining}/${task.duration}</span>
        <span>资源 ${held}</span>
        <span>等待 ${waiting}</span>
      </div>`;
  }).join('');
  elements.tasks.innerHTML = `
    <div class="task-row table-head">
      <span></span><strong>ID</strong><span>状态</span><span>优先级</span><span>尝试</span><span>进度</span><span>持有</span><span>等待</span>
    </div>${rows}`;
}

function renderEvents() {
  elements.events.innerHTML = snapshot.events.slice(-80).reverse().map((event) => `
    <li class="event ${event.severity}">
      <time>t=${event.time}</time>
      <span>${event.message}</span>
    </li>
  `).join('');
}

elements.scenario.addEventListener('change', () => {
  const scenario = scenarios.find((item) => item.id === elements.scenario.value);
  initWorker(structuredClone(scenario.config));
});
elements.reset.addEventListener('click', resetCurrentScenario);
elements.step.addEventListener('click', () => post({ type: 'tick' }));
elements.play.addEventListener('click', () => timer ? stopPlayback() : startPlayback());
elements.speed.addEventListener('input', () => {
  elements.speedValue.textContent = `${elements.speed.value}ms`;
  if (timer) {
    stopPlayback();
    startPlayback();
  }
});
elements.file.addEventListener('change', async () => {
  const file = elements.file.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const config = parsed.config ?? parsed;
    elements.scenario.value = '';
    initWorker(structuredClone(config));
  } catch (error) {
    alert(`场景导入失败：${error.message}`);
  } finally {
    elements.file.value = '';
  }
});
window.addEventListener('resize', () => {
  if (snapshot) renderAll({ dag: elements.dag, gantt: elements.gantt }, snapshot);
});

elements.speedValue.textContent = `${elements.speed.value}ms`;
initWorker(structuredClone(scenarios[0].config));
