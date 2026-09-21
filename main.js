/* 主线程：Worker 通信 + Canvas 可视化（Gantt 时间线 / 依赖 DAG）+ 状态表 + 事件日志 */
(function () {
  'use strict';

  /* ---- 创建 Worker：Blob 方式内联调度器源码，file:// 直接打开也能运行 ---- */
  const workerSrc = Scheduler.toString() + '\n;\n(' + schedulerWorkerMain.toString() + ')();';
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' })));

  const $ = id => document.getElementById(id);
  const ganttCanvas = $('gantt');
  const dagCanvas = $('dag');
  const ganttScroll = $('ganttScroll');

  const STATE_COLORS = {
    pending: '#5a5f6a', ready: '#2196f3', running: '#4caf50',
    done: '#00897b', failed: '#e53935', deadlocked: '#ff5722',
  };
  const STATE_NAMES = {
    pending: '等待依赖', ready: '就绪', running: '运行',
    done: '完成', failed: '失败', deadlocked: '死锁',
  };
  const EVENT_COLORS = {
    dispatch: '#64b5f6', preempt: '#ffb74d', slice: '#90a4ae', timeout: '#ef5350',
    fail: '#ff5252', cascade: '#ff8a80', deadlock: '#ff1744', boost: '#ce93d8',
    done: '#66bb6a', ready: '#4fc3f7', finished: '#ffd54f',
  };

  let snap = null;
  let ganttTicks = [];   // ganttTicks[tick-1] = [taskId|null, ...] 每个核心
  let tickEvents = [];   // tickEvents[tick-1] = [event, ...]
  let taskColor = {};

  // 老浏览器 roundRect 回退
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
      this.rect(x, y, w, h);
      return this;
    };
  }

  /* ---------------- Worker 通信 ---------------- */

  function currentConfig() {
    return { cores: +$('cores').value, quantum: 4, inheritance: $('chkInherit').checked };
  }

  function initScheduler() {
    ganttTicks = [];
    tickEvents = [];
    $('eventLog').innerHTML = '';
    worker.postMessage({ type: 'init', tasks: buildTasks($('chkDeadlock').checked), config: currentConfig() });
    setRunning(false);
  }

  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'snapshot') {
      snap = m.snap;
      for (const t of snap.tasks) taskColor[t.id] = t.color;
      if (snap.tick > 0) {
        ganttTicks[snap.tick - 1] = snap.cores.map(c => (c ? c.id : null));
        tickEvents[snap.tick - 1] = snap.events;
        appendLog(snap.events);
      }
      renderAll();
      if (snap.finished) setRunning(false);
    } else if (m.type === 'finished') {
      setRunning(false);
    }
  };

  function setRunning(on) {
    $('btnStart').disabled = on;
    $('btnPause').disabled = !on;
    $('btnStep').disabled = on;
  }

  $('btnStart').onclick = () => { worker.postMessage({ type: 'start' }); setRunning(true); };
  $('btnPause').onclick = () => { worker.postMessage({ type: 'pause' }); setRunning(false); };
  $('btnStep').onclick = () => worker.postMessage({ type: 'step' });
  $('btnReset').onclick = initScheduler;
  $('speed').oninput = e => {
    $('speedVal').textContent = e.target.value;
    worker.postMessage({ type: 'speed', tps: +e.target.value });
  };
  $('chkInherit').onchange = e =>
    worker.postMessage({ type: 'config', config: { inheritance: e.target.checked } });
  $('chkDeadlock').onchange = initScheduler;
  $('cores').onchange = initScheduler;

  /* ---------------- 渲染：Gantt ---------------- */

  function setupCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function renderGantt() {
    const cores = snap ? snap.cores.length : currentConfig().cores;
    const cellW = 14, rowH = 34, labelW = 52, topH = 20, markerH = 26;
    const ticks = ganttTicks.length;
    const W = Math.max(760, labelW + ticks * cellW + 30);
    const H = topH + cores * rowH + markerH + 8;
    const ctx = setupCanvas(ganttCanvas, W, H);

    ctx.fillStyle = '#1b1e27';
    ctx.fillRect(0, 0, W, H);

    // 网格 + tick 刻度
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let t = 0; t <= ticks; t++) {
      const x = labelW + t * cellW;
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.beginPath(); ctx.moveTo(x, topH); ctx.lineTo(x, topH + cores * rowH); ctx.stroke();
      if (t % 5 === 0) { ctx.fillStyle = '#8b93a5'; ctx.fillText(t, x, 12); }
    }

    // 每个核心的运行块（连续段合并）
    for (let c = 0; c < cores; c++) {
      ctx.fillStyle = '#aab2c5';
      ctx.textAlign = 'left';
      ctx.font = '11px sans-serif';
      ctx.fillText('CPU' + c, 8, topH + c * rowH + rowH / 2 + 4);
      let t = 0;
      while (t < ticks) {
        const id = ganttTicks[t][c];
        if (!id) { t++; continue; }
        let len = 1;
        while (t + len < ticks && ganttTicks[t + len][c] === id) len++;
        const x = labelW + t * cellW, y = topH + c * rowH + 3, w = len * cellW - 1, h = rowH - 6;
        ctx.fillStyle = taskColor[id] || '#999';
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 3);
        ctx.fill();
        if (w >= 14) {
          ctx.fillStyle = '#10121a';
          ctx.textAlign = 'center';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText(id, x + w / 2, y + h / 2 + 4);
        }
        t += len;
      }
    }

    // 事件标记行：抢占/超时/死锁/提升等重要事件画彩色圆点
    const my = topH + cores * rowH + 14;
    ctx.fillStyle = '#8b93a5';
    ctx.textAlign = 'left';
    ctx.font = '10px sans-serif';
    ctx.fillText('事件', 8, my + 3);
    const priority = ['deadlock', 'fail', 'cascade', 'timeout', 'preempt', 'boost', 'done'];
    for (let t = 0; t < ticks; t++) {
      const evs = tickEvents[t];
      if (!evs || !evs.length) continue;
      let best = evs[0];
      for (const p of priority) {
        const hit = evs.find(e => e.type === p);
        if (hit) { best = hit; break; }
      }
      ctx.fillStyle = EVENT_COLORS[best.type] || '#fff';
      ctx.beginPath();
      ctx.arc(labelW + t * cellW + cellW / 2, my, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ganttScroll.scrollLeft = ganttScroll.scrollWidth;
  }

  /* ---------------- 渲染：依赖 DAG ---------------- */

  function computeLayers(tasks) {
    const ids = new Set(tasks.map(t => t.id));
    const layer = new Map();
    let frontier = tasks.filter(t => t.deps.every(d => !ids.has(d))).map(t => t.id);
    let l = 0;
    while (frontier.length) {
      for (const id of frontier) layer.set(id, l);
      frontier = tasks
        .filter(t => !layer.has(t.id))
        .filter(t => t.deps.every(d => !ids.has(d) || layer.has(d)))
        .map(t => t.id);
      l++;
      if (l > tasks.length + 2) break; // 防御
    }
    // 环上的节点（死锁）放到最后一层
    tasks.filter(t => !layer.has(t.id)).forEach(t => layer.set(t.id, l));
    return layer;
  }

  function drawArrow(ctx, a, b, color) {
    const r = 26;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const sx = a.x + (dx / dist) * r, sy = a.y + (dy / dist) * r;
    const ex = b.x - (dx / dist) * (r + 4), ey = b.y - (dy / dist) * (r + 4);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    const ang = Math.atan2(ey - sy, ex - sx);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 8 * Math.cos(ang - 0.4), ey - 8 * Math.sin(ang - 0.4));
    ctx.lineTo(ex - 8 * Math.cos(ang + 0.4), ey - 8 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  function renderDAG() {
    if (!snap) return;
    const tasks = snap.tasks;
    const W = 960, H = 400;
    const ctx = setupCanvas(dagCanvas, W, H);
    ctx.fillStyle = '#1b1e27';
    ctx.fillRect(0, 0, W, H);

    const layers = computeLayers(tasks);
    const byLayer = new Map();
    layers.forEach((l, id) => {
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(id);
    });
    const maxLayer = Math.max(...layers.values(), 1);
    const pos = new Map();
    byLayer.forEach((ids, l) => {
      ids.forEach((id, i) => {
        pos.set(id, { x: 80 + l * (800 / maxLayer), y: ((i + 1) * H) / (ids.length + 1) });
      });
    });

    // 边：死锁相关的边标红
    const stateOf = id => (tasks.find(t => t.id === id) || {}).state;
    for (const t of tasks) {
      for (const d of t.deps) {
        const a = pos.get(d), b = pos.get(t.id);
        if (!a || !b) continue;
        const bad = t.state === 'deadlocked' || stateOf(d) === 'deadlocked';
        drawArrow(ctx, a, b, bad ? '#ff1744' : 'rgba(160,170,190,.45)');
      }
    }

    // 节点：状态底色 + 黄色进度环 + 紫色继承描边
    for (const t of tasks) {
      const p = pos.get(t.id);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.fillStyle = STATE_COLORS[t.state];
      ctx.fill();
      if (t.boosted) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ce93d8';
        ctx.stroke();
      }
      if (t.progress > 0 && t.state !== 'done') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 29, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.id, p.x, p.y);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#aab2c5';
      const pri = t.boosted ? `P${t.priority}→${t.effPri}` : `P${t.priority}`;
      ctx.fillText(`${t.name} ${pri}`, p.x, p.y + 40);
    }
  }

  /* ---------------- 渲染：状态表 / 日志 / 状态栏 ---------------- */

  function renderTable() {
    if (!snap) return;
    $('taskRows').innerHTML = snap.tasks.map(t => {
      const pct = Math.round(t.progress * 100);
      const pri = t.boosted
        ? `<span class="boosted">${t.priority}→${t.effPri}</span>`
        : String(t.priority);
      const retry = t.maxRetries ? `${t.attempts}/${t.maxRetries}` : '-';
      return `<tr>
        <td><span class="chip" style="background:${t.color}"></span>${t.id}</td>
        <td>${t.name}</td>
        <td><span class="badge" style="background:${STATE_COLORS[t.state]}">${STATE_NAMES[t.state]}</span></td>
        <td>${pri}</td>
        <td><div class="bar"><div style="width:${pct}%"></div></div></td>
        <td>${t.remaining}/${t.duration}</td>
        <td>${t.sliceUsed}</td>
        <td>${retry}</td>
        <td>${t.deps.join(', ') || '-'}</td>
      </tr>`;
    }).join('');
  }

  function renderStatus() {
    if (!snap) return;
    const count = s => snap.tasks.filter(t => t.state === s).length;
    $('statusBar').innerHTML =
      `Tick <b>${snap.tick}</b>　运行 ${count('running')}　就绪 ${count('ready')}　` +
      `等待 ${count('pending')}　完成 ${count('done')}　失败 ${count('failed')}　` +
      `死锁 ${count('deadlocked')}` +
      (snap.finished ? '　<b class="fin">■ 调度结束</b>' : '');
  }

  function appendLog(events) {
    const log = $('eventLog');
    for (const e of events) {
      const div = document.createElement('div');
      div.className = 'log-entry';
      div.innerHTML =
        `<span class="log-tick">[${String(e.tick).padStart(3, '0')}]</span>` +
        `<span class="log-type" style="color:${EVENT_COLORS[e.type] || '#fff'}">${e.type}</span> ${e.msg}`;
      log.appendChild(div);
    }
    while (log.children.length > 400) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderGantt();
    renderDAG();
    renderTable();
    renderStatus();
  }

  initScheduler();
})();
