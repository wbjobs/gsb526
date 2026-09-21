/*
 * 演示场景：覆盖全部验收标准
 *  - 抢占：B(8)/F(9) 会抢占低优先级任务
 *  - 依赖 DAG：A→D→F，A+B→E，C→G→H，I→J
 *  - 超时重试：G 时长 8 > 超时 5，重试 2 次后失败
 *  - 异常链路：G 失败 → H 级联失败
 *  - 优先级反转：J(10) 依赖 I(1)，继承开启时 I 被提升到 10
 *  - 死锁注入：勾选后 K↔L 循环等待
 */
'use strict';

const SCENARIO = [
  { id: 'A', name: '数据加载',   priority: 5,  duration: 6,  deps: [],          color: '#4fc3f7' },
  { id: 'B', name: '配置解析',   priority: 8,  duration: 4,  deps: [],          color: '#ba68c8' },
  { id: 'C', name: '日志初始化', priority: 3,  duration: 10, deps: [],          color: '#fff176' },
  { id: 'D', name: '索引构建',   priority: 6,  duration: 5,  deps: ['A'],       color: '#81c784' },
  { id: 'E', name: '缓存预热',   priority: 7,  duration: 4,  deps: ['A', 'B'],  color: '#ffb74d' },
  { id: 'F', name: '核心计算',   priority: 9,  duration: 3,  deps: ['D'],       color: '#e57373' },
  { id: 'G', name: '网络同步',   priority: 2,  duration: 8,  deps: ['C'],       color: '#a1887f', timeout: 5, maxRetries: 2 },
  { id: 'H', name: '结果上报',   priority: 4,  duration: 4,  deps: ['G'],       color: '#90a4ae' },
  { id: 'I', name: '低优先后台', priority: 1,  duration: 12, deps: [],          color: '#9575cd' },
  { id: 'J', name: '关键响应',   priority: 10, duration: 3,  deps: ['I'],       color: '#f06292' },
  { id: 'K', name: '任务K',      priority: 5,  duration: 4,  deps: [],          color: '#4db6ac' },
  { id: 'L', name: '任务L',      priority: 5,  duration: 4,  deps: ['K'],       color: '#aed581' },
];

function buildTasks(injectDeadlock) {
  return SCENARIO.map(t => {
    const copy = Object.assign({}, t, { deps: t.deps.slice() });
    if (injectDeadlock) {
      if (copy.id === 'K') copy.deps = ['L'];
      if (copy.id === 'L') copy.deps = ['K'];
    }
    return copy;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SCENARIO, buildTasks };
}
