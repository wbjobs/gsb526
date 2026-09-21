export const scenarios = [
  {
    id: 'all-risks',
    name: '综合验收：抢占 / DAG / 死锁 / 超时',
    config: {
      quantum: 2,
      retryDelay: 2,
      tasks: [
        { id: 'A', label: '低优先级持锁', priority: 2, duration: 6, arrival: 0, locks: ['R1'], x: 80, y: 120 },
        { id: 'H', label: '高优先级抢占', priority: 9, duration: 2, arrival: 1, x: 520, y: 70 },
        { id: 'B', label: '中优先级等待 R1', priority: 5, duration: 3, arrival: 2, locks: ['R1'], x: 520, y: 170 },
        { id: 'C', label: '超时后重试', priority: 6, duration: 5, timeout: 2, retries: 1, failAt: null, x: 520, y: 280 },
        { id: 'X', label: '依赖 A 完成', priority: 7, duration: 2, deps: ['A'], x: 80, y: 290 },
        { id: 'Y', label: '依赖 X 完成', priority: 4, duration: 2, deps: ['X'], x: 80, y: 410 },
        { id: 'D', label: '死锁甲 R2→R3', priority: 4, duration: 5, arrival: 10, lockRequests: [{ lock: 'R2', at: 0 }, { lock: 'R3', at: 3 }], x: 80, y: 535 },
        { id: 'E', label: '死锁乙 R3→R2', priority: 4, duration: 5, arrival: 10, lockRequests: [{ lock: 'R3', at: 0 }, { lock: 'R2', at: 3 }], x: 520, y: 535 },
        { id: 'Z', label: '失败依赖级联', priority: 8, duration: 4, timeout: 1, retries: 0, arrival: 18, x: 300, y: 680 },
        { id: 'W', label: '等待 Z，将跳过', priority: 5, duration: 2, arrival: 18, deps: ['Z'], x: 540, y: 680 }
      ]
    }
  },
  {
    id: 'priority',
    name: '高优先级抢占与时间片公平',
    config: {
      quantum: 2,
      tasks: [
        { id: 'LOW', label: 'LOW', priority: 1, duration: 8, x: 90, y: 110 },
        { id: 'EQ1', label: '同优先级 A', priority: 4, duration: 5, arrival: 0, x: 90, y: 300 },
        { id: 'EQ2', label: '同优先级 B', priority: 4, duration: 5, arrival: 0, x: 520, y: 300 },
        { id: 'HIGH', label: 'HIGH', priority: 9, duration: 2, arrival: 3, x: 520, y: 110 }
      ]
    }
  },
  {
    id: 'dag-retry',
    name: 'DAG 门控与异常链路',
    config: {
      quantum: 2,
      retryDelay: 1,
      tasks: [
        { id: 'FETCH', label: '拉取数据', priority: 5, duration: 2, x: 90, y: 100 },
        { id: 'FLAKEY', label: '首次异常重试', priority: 6, duration: 3, retries: 1, failAt: 1, x: 340, y: 230 },
        { id: 'TRANSFORM', label: '转换', priority: 5, duration: 3, deps: ['FETCH', 'FLAKEY'], x: 340, y: 390 },
        { id: 'REPORT', label: '生成报告', priority: 7, duration: 2, deps: ['TRANSFORM'], x: 90, y: 530 }
      ]
    }
  }
];
