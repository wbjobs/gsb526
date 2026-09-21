# DAG 优先级抢占调度器

一个无第三方运行时依赖的教学型调度器：Web Worker 运行确定性模拟，Canvas 绘制任务状态、DAG、资源等待边和 CPU Gantt。

## 运行

```bash
npm test
npm start
# 打开 http://localhost:5173
```

## 支持能力

- 优先级调度：数值越大优先级越高，支持高优先级任务在 tick 边界抢占低优先级任务。
- 时间片公平：同优先级使用最小 `vruntime` 轮转，时间片到期切换。
- 依赖 DAG：所有 `deps` 完成后任务才进入 READY；依赖失败会沿 DAG 级联 SKIPPED。
- 资源互斥：`lockRequests` 按执行时刻申请资源，阻塞时让出 CPU。
- 优先级反转：只对资源等待边做传递式优先级继承，DAG 依赖不会错误提升优先级。
- 死锁检测：每 tick 根据资源等待图构建 Tarjan SCC，发现强连通资源环后终止低有效优先级受害者。
- 超时与重试：按单次尝试计时，超时或首次瞬时异常后进入 WAITING_RETRY，到期重新执行。
- 异常链路：失败事件包含根任务和所有下游 SKIPPED 节点，UI 同步展示。

## 场景格式

```json
{
  "quantum": 2,
  "retryDelay": 2,
  "tasks": [
    {
      "id": "A",
      "priority": 5,
      "duration": 4,
      "arrival": 0,
      "timeout": 3,
      "retries": 1,
      "deps": [],
      "lockRequests": [{ "lock": "R1", "at": 0 }],
      "x": 100,
      "y": 120
    }
  ]
}
```

`at` 是任务当前尝试已执行的 tick 数；例如 `at: 0` 表示获得 CPU 时申请，`at: 2` 表示执行两 tick 后申请。也兼容简写 `locks: ["R1"]`，这些资源都在启动时申请。

## 文件结构

- `src/scheduler.js`：纯 ES Module 调度核心，可直接在 Node 中测试。
- `src/worker.js`：Worker 消息封装。
- `src/canvas-view.js`：DAG 与 Gantt Canvas 渲染。
- `src/scenarios.js`：抢占、公平、DAG、重试和死锁验收场景。
- `tests/scheduler.test.js`：调度语义自动化测试。
