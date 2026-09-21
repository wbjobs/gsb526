const STATE_COLORS = {
  PENDING: '#64748b',
  READY: '#f59e0b',
  RUNNING: '#22c55e',
  PREEMPTED: '#06b6d4',
  BLOCKED: '#f97316',
  WAITING_RETRY: '#a855f7',
  COMPLETED: '#16a34a',
  FAILED: '#dc2626',
  DEADLOCKED: '#991b1b',
  SKIPPED: '#94a3b8'
};

export function renderAll(canvases, snapshot) {
  renderDag(canvases.dag, snapshot);
  renderGantt(canvases.gantt, snapshot);
}

export function stateColor(state) {
  return STATE_COLORS[state] ?? '#64748b';
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(240, Math.floor(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function renderDag(canvas, snapshot) {
  const { ctx, width, height } = prepareCanvas(canvas);
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const positions = assignDagPositions(snapshot, width, height);

  drawGrid(ctx, width, height);
  ctx.lineCap = 'round';

  for (const task of snapshot.tasks) {
    for (const dep of task.deps) {
      const from = positions.get(dep);
      const to = positions.get(task.id);
      const depTask = tasks.get(dep);
      drawArrow(ctx, from.x + 78, from.y, to.x - 78, to.y, depTask && depTask.state === 'COMPLETED' ? '#22c55e' : '#7c8aa5', 'dependency');
    }
  }

  for (const edge of snapshot.waitEdges) {
    if (edge.reason !== 'resource') continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    drawArrow(ctx, from.x, from.y + 28, to.x, to.y + 28, '#ef4444', 'resource', edge.resource);
  }

  for (const cycle of snapshot.deadlockCycles) {
    const points = cycle.cycle.map((id) => positions.get(id)).filter(Boolean);
    if (points.length >= 2) {
      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const task of snapshot.tasks) {
    const point = positions.get(task.id);
    const selected = task.id === snapshot.cpuTaskId;
    const color = stateColor(task.state);
    ctx.save();
    ctx.shadowColor = selected ? 'rgba(34,197,94,.45)' : 'rgba(15,23,42,.16)';
    ctx.shadowBlur = selected ? 22 : 10;
    roundedRect(ctx, point.x - 78, point.y - 31, 156, 62, 14);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = color;
    roundedRect(ctx, point.x - 78, point.y - 31, 10, 62, 5);
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.font = '700 14px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(task.id, point.x, point.y - 9);
    ctx.fillStyle = '#475569';
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.fillText(stateLabel(task.state), point.x, point.y + 8);
    ctx.fillText(`P${task.basePriority}${task.effectivePriority !== task.basePriority ? `↟P${task.effectivePriority}` : ''}  ${task.duration - task.remaining}/${task.duration}`, point.x, point.y + 24);
    if (selected) {
      ctx.fillStyle = '#16a34a';
      ctx.beginPath();
      ctx.arc(point.x + 62, point.y - 22, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawLegend(ctx, 12, height - 42, [
    ['依赖', '#7c8aa5'],
    ['资源等待', '#ef4444'],
    ['CPU', '#22c55e']
  ]);
}

function assignDagPositions(snapshot, width, height) {
  const provided = snapshot.tasks.filter((task) => task.x || task.y);
  if (provided.length === snapshot.tasks.length) {
    return new Map(snapshot.tasks.map((task) => [task.id, { x: scaleX(task.x, width), y: scaleY(task.y, height) }]));
  }
  const depth = new Map();
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const calculate = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const task = byId.get(id);
    const value = task.deps.length === 0 ? 0 : Math.max(...task.deps.map((dep) => calculate(dep, seen) + 1));
    depth.set(id, value);
    return value;
  };
  snapshot.tasks.forEach((task) => calculate(task.id));
  const rows = new Map();
  for (const task of snapshot.tasks) {
    const row = depth.get(task.id) ?? 0;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(task.id);
  }
  const positions = new Map();
  const maxRow = Math.max(...rows.keys(), 1);
  for (const [row, ids] of rows) {
    ids.forEach((id, index) => {
      positions.set(id, {
        x: 120 + index * 190,
        y: 70 + row * ((height - 120) / Math.max(1, maxRow))
      });
    });
  }
  return positions;
}

function scaleX(value, width) {
  return 90 + (value / 640) * Math.max(0, width - 180);
}

function scaleY(value, height) {
  return 48 + (value / 760) * Math.max(0, height - 88);
}

function drawArrow(ctx, x1, y1, x2, y2, color, type, label = '') {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const startX = x1 + ux * 8;
  const startY = y1 + uy * 8;
  const endX = x2 - ux * 12;
  const endY = y2 - uy * 12;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = type === 'resource' ? 2 : 1.6;
  if (type === 'resource') ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);
  const angle = Math.atan2(dy, dx);
  ctx.translate(endX, endY);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-8, -5);
  ctx.lineTo(-8, 5);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-angle);
  if (label) {
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(label, (startX + endX) / 2, (startY + endY) / 2 - 6);
  }
  ctx.restore();
}

function drawGrid(ctx, width, height) {
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(100,116,139,.10)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawLegend(ctx, x, y, items) {
  ctx.font = '12px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  let cursor = x;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(cursor, y, 18, 4);
    ctx.fillStyle = '#475569';
    ctx.fillText(label, cursor + 24, y + 5);
    cursor += 24 + ctx.measureText(label).width + 22;
  }
}

function stateLabel(state) {
  return {
    PENDING: '等待依赖/到达',
    READY: '就绪',
    RUNNING: '运行中',
    PREEMPTED: '已抢占',
    BLOCKED: '资源阻塞',
    WAITING_RETRY: '等待重试',
    COMPLETED: '已完成',
    FAILED: '失败',
    DEADLOCKED: '死锁中止',
    SKIPPED: '已跳过'
  }[state] ?? state;
}

function renderGantt(canvas, snapshot) {
  const { ctx, width, height } = prepareCanvas(canvas);
  drawGrid(ctx, width, height);
  const tasks = snapshot.taskOrder;
  const left = 92;
  const top = 24;
  const rowHeight = Math.min(34, Math.max(18, (height - 48) / Math.max(1, tasks.length)));
  const visibleTicks = Math.max(10, Math.min(32, Math.max(snapshot.time + 1, snapshot.taskOrder.length * 2)));
  const startTick = Math.max(0, snapshot.time + 1 - visibleTicks);
  const plotWidth = width - left - 18;
  const cellWidth = plotWidth / visibleTicks;

  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  for (let tick = startTick; tick <= startTick + visibleTicks; tick += 2) {
    const x = left + (tick - startTick) * cellWidth;
    ctx.strokeStyle = 'rgba(100,116,139,.18)';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, height - 18);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(tick, x, 14);
  }

  tasks.forEach((id, index) => {
    const task = snapshot.tasks.find((item) => item.id === id);
    const y = top + index * rowHeight;
    ctx.fillStyle = index % 2 === 0 ? 'rgba(226,232,240,.45)' : 'rgba(248,250,252,.8)';
    ctx.fillRect(0, y, width, rowHeight - 2);
    ctx.fillStyle = '#334155';
    ctx.textAlign = 'right';
    ctx.fillText(id, left - 10, y + rowHeight / 2 + 4);
  });

  for (let tick = startTick; tick < startTick + visibleTicks; tick += 1) {
    const stateRow = snapshot.statusRows?.findLast?.((row) => row.time <= tick);
    if (!stateRow) continue;
    const x = left + (tick - startTick) * cellWidth;
    snapshot.taskOrder.forEach((id, index) => {
      const state = stateRow.states[id];
      if (!state || state === 'PENDING') return;
      const y = top + index * rowHeight;
      ctx.save();
      ctx.globalAlpha = state === 'RUNNING' ? 0.22 : 0.13;
      ctx.fillStyle = stateColor(state);
      ctx.fillRect(x, y, cellWidth, rowHeight - 2);
      ctx.restore();
    });
  }

  for (const slice of snapshot.gantt) {
    if (slice.end <= startTick || slice.start >= startTick + visibleTicks) continue;
    const row = tasks.indexOf(slice.taskId);
    if (row < 0) continue;
    const task = snapshot.tasks.find((item) => item.id === slice.taskId);
    const x = left + Math.max(0, slice.start - startTick) * cellWidth;
    const widthTicks = Math.min(slice.end, startTick + visibleTicks) - Math.max(slice.start, startTick);
    const y = top + row * rowHeight + 4;
    ctx.fillStyle = taskColor(task.id);
    roundedRect(ctx, x + 1, y, Math.max(2, widthTicks * cellWidth - 2), rowHeight - 10, 5);
    ctx.fill();
    if (slice.reason !== 'run') {
      ctx.fillStyle = 'rgba(15,23,42,.72)';
      ctx.fillRect(x + widthTicks * cellWidth - 4, y, 3, rowHeight - 10);
    }
  }

  const nowX = left + Math.min(visibleTicks, snapshot.time - startTick) * cellWidth;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nowX, top - 4);
  ctx.lineTo(nowX, height - 18);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#475569';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillText(`当前 tick: ${snapshot.time}，时间片: ${snapshot.quantum}`, 12, height - 6);
}

const taskColors = new Map();

function taskColor(id) {
  if (!taskColors.has(id)) {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
    taskColors.set(id, `hsl(${hash} 72% 54%)`);
  }
  return taskColors.get(id);
}
