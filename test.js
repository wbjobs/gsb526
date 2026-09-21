/* 验收测试：node test.js */
'use strict';
const assert = require('assert');
const { Scheduler } = require('./scheduler.js');
const { buildTasks } = require('./scenario.js');

function run(tasks, config, maxTicks = 1000) {
  const s = new Scheduler(tasks, config);
  const events = [], snaps = [];
  while (!s.done && s.tick < maxTicks) {
    s.step();
    const sn = s.snapshot();
    events.push(...sn.events);
    snaps.push(sn);
  }
  return { s, events, snaps };
}

/* 1) 基准场景：抢占 / 依赖 / 优先级继承 / 超时重试 / 异常链路 */
{
  const { s, events, snaps } = run(buildTasks(false), { cores: 2, quantum: 4, inheritance: true });
  assert(s.done, '调度应正常结束');

  // 依赖约束：任何任务在核心上运行时，其全部依赖必须已完成
  for (const sn of snaps) {
    const state = new Map(sn.tasks.map(t => [t.id, t.state]));
    for (const c of sn.cores) {
      if (!c) continue;
      const t = sn.tasks.find(x => x.id === c.id);
      for (const d of t.deps) {
        assert.strictEqual(state.get(d), 'done',
          `${t.id} 在依赖 ${d} 完成前运行 (tick ${sn.tick})`);
      }
    }
  }

  // 高优先级抢占低优先级
  const pre = events.find(e => e.type === 'preempt');
  assert(pre, '应发生抢占');
  console.log('  抢占示例:', pre.msg);

  // 优先级继承解除反转
  assert(events.some(e => e.type === 'boost' && e.taskId === 'I'), 'I 应被优先级继承提升');

  // 超时重试：G 重试 2 次后失败
  assert.strictEqual(events.filter(e => e.type === 'timeout' && e.taskId === 'G').length, 2,
    'G 应超时重试 2 次');
  assert(events.some(e => e.type === 'fail' && e.taskId === 'G'), 'G 重试耗尽后应失败');

  // 异常链路：H 因 G 失败级联失败
  assert(events.some(e => e.type === 'cascade' && e.taskId === 'H'), 'H 应级联失败');
  console.log('✓ 基准场景：抢占 / 依赖 / 继承 / 超时重试 / 异常链路');
}

/* 2) 死锁检测 */
{
  const { s, events } = run(buildTasks(true), { cores: 2, quantum: 4, inheritance: true });
  assert(s.done, '含死锁时调度仍应结束（其余任务不受影响）');
  const dl = events.filter(e => e.type === 'deadlock').map(e => e.taskId);
  assert(dl.includes('K') && dl.includes('L'), 'K/L 应被检测为死锁');
  const ks = events.find(e => e.type === 'deadlock');
  console.log('  死锁示例:', ks.msg);
  console.log('✓ 死锁检测');
}

/* 3) 优先级反转对比：关闭继承后 J 完成显著变晚 */
{
  const inh = run(buildTasks(false), { cores: 2, quantum: 4, inheritance: true });
  const noInh = run(buildTasks(false), { cores: 2, quantum: 4, inheritance: false });
  assert(!noInh.events.some(e => e.type === 'boost'), '关闭继承时不应有提升');
  const doneTick = (r, id) => r.events.find(e => e.type === 'done' && e.taskId === id).tick;
  const withInh = doneTick(inh, 'J'), without = doneTick(noInh, 'J');
  assert(without > withInh, `无继承时 J 完成应更晚（${without} > ${withInh}）`);
  console.log(`  J 完成 tick：继承开 ${withInh} / 继承关 ${without}`);
  console.log('✓ 优先级反转处理（继承对比）');
}

/* 4) 时间片公平性：单核下同优先级任务轮换 */
{
  const { s, events } = run(buildTasks(false), { cores: 1, quantum: 3, inheritance: false });
  assert(s.done, '单核调度应结束');
  assert(events.some(e => e.type === 'slice'), '应发生时间片轮换');
  const sl = events.find(e => e.type === 'slice');
  console.log('  轮换示例:', sl.msg);
  console.log('✓ 时间片公平性');
}

console.log('\n全部验收测试通过 ✅');
