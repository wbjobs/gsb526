# 任务调度器可视化

基于 **Web Worker + Canvas + 自定义调度器** 的抢占式任务调度模拟器。

## 运行

直接用浏览器打开 `index.html` 即可（调度器源码通过 Blob 内联进 Worker，无需本地服务器）。
也可以 `python3 -m http.server` 后访问。

## 测试

```bash
node test.js
```

## 功能与验收对照

| 验收标准 | 实现 | 演示场景 |
|---|---|---|
| 高优先级抢占低优先级 | `Scheduler.preempt()`：就绪队首有效优先级 > 运行中最低者即换出，进度保留 | F(9)/J(10) 抢占低优先级任务 |
| 依赖未完成不执行 | `pending → ready` 状态门控，测试逐 tick 断言 | A→D→F、A+B→E |
| 死锁可检测 | 等待图 DFS 三色标记找环 | 勾选"注入死锁"后 K↔L 被标记 |
| 超时有重试 | 单次尝试运行时长超 `timeout` 触发重试，耗尽后失败 | G 超时 5t、重试 2 次后失败 |
| 可视化准确 | 每 tick 快照驱动 Gantt / DAG / 状态表 / 日志 | 与 Worker 内状态严格一致 |

附加机制：

- **优先级反转**：J(10) 依赖 I(1)。开启"优先级继承"（默认）时 I 被提升到 10 立即运行；
  关闭后 I 饥饿、J 完成 tick 从 15 推迟到 31（`test.js` 自动对比）。
- **时间片公平性**：同级任务按 quantum 轮转，就绪队列按"最久未运行"排序。
- **异常链路**：G 重试耗尽失败 → H 因依赖失败级联失败；依赖死锁任务同样级联。

## 架构

```
index.html / styles.css     UI 骨架
scenario.js                 演示场景（浏览器与 Node 测试共用）
scheduler.js                调度核心（纯逻辑）+ Worker 入口
main.js                     主线程：Worker 通信 + Canvas 渲染（Gantt / DAG）
test.js                     Node 验收测试
```

- 调度器在 **Web Worker** 中按 tick 推进，主线程只消费快照渲染，UI 永不阻塞调度。
- Worker 由 `Scheduler.toString()` 拼接成 Blob 创建，因此 `file://` 协议下也能运行。
- 任务状态机：`pending → ready → running → done`，分支 `→ failed`（超时耗尽/级联）、`→ deadlocked`（循环等待）。
