/**
 * 区间重划领域逻辑验证（node + fake-indexeddb）
 * 覆盖：
 *  1. 拆分提交：环片/裂缝 sectionId 迁移、id 不变、环数重算、速率统计按新分段
 *  2. 合并提交与撤销来源区间
 *  3. 三类阻断：里程重叠 / 环号碰撞 / 环片超界（找不到所属）
 *  4. 孤裂缝（裂缝 ringId 找不到环）
 *  5. 断点续跑：人为中断后重试，从上次停止处继续
 *  6. 快照回滚回填原归属
 *  7. v2 旧备份（无 adjustments）导入
 */
import 'fake-indexeddb/auto'
import { assert } from 'node:console'
import {
  db,
  seedDatabase,
  importSnapshot,
  exportSnapshot,
  type SectionRow,
  type RingRow,
  type CrackRow
} from '../src/utils/db.ts'
import {
  applyAdjustment,
  createAdjustmentOrder,
  rollbackAdjustment,
  validateOrder
} from '../src/utils/sectionAdjust.ts'

let passed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed++
    console.log(`✓ ${name}`)
  }
}

async function reset(): Promise<void> {
  await db.table('sections').clear()
  await db.table('rings').clear()
  await db.table('cracks').clear()
  await db.table('surveys').clear()
  await db.table('advices').clear()
  await db.table('adjustments').clear()
}

async function seedCustom(): Promise<{ secA: SectionRow; secB: SectionRow; rings: RingRow[]; cracks: CrackRow[] }> {
  await reset()
  const now = Date.now()
  const secA: SectionRow = {
    id: 'secA',
    line: '1号线',
    startMileage: 1000,
    endMileage: 2000,
    structureType: '盾构',
    ringCount: 3,
    createdAt: now,
    updatedAt: now,
    revision: 2
  }
  const secB: SectionRow = {
    id: 'secB',
    line: '1号线',
    startMileage: 2000,
    endMileage: 3000,
    structureType: '盾构',
    ringCount: 2,
    createdAt: now,
    updatedAt: now,
    revision: 2
  }
  const rings: RingRow[] = [
    { id: 'r1', sectionId: 'secA', ringNo: 1, mileage: 1100, segmentType: '钢筋混凝土', installDate: '2020-01-01', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'r2', sectionId: 'secA', ringNo: 2, mileage: 1600, segmentType: '钢筋混凝土', installDate: '2020-01-02', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'r3', sectionId: 'secA', ringNo: 3, mileage: 1900, segmentType: '铸铁', installDate: '2020-01-03', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'r4', sectionId: 'secB', ringNo: 4, mileage: 2100, segmentType: '钢筋混凝土', installDate: '2020-02-01', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'r5', sectionId: 'secB', ringNo: 5, mileage: 2600, segmentType: '钢管片', installDate: '2020-02-02', createdAt: now, updatedAt: now, revision: 2 }
  ]
  const cracks: CrackRow[] = [
    { id: 'c1', ringId: 'r1', sectionId: 'secA', code: 'C1', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 100, state: '观察', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'c2', ringId: 'r3', sectionId: 'secA', code: 'C2', position: '侧墙', direction: '环向', widthMm: 0.3, lengthMm: 200, state: '观察', createdAt: now, updatedAt: now, revision: 2 },
    { id: 'c3', ringId: 'r4', sectionId: 'secB', code: 'C3', position: '道床', direction: '斜向', widthMm: 0.4, lengthMm: 300, state: '待整治', createdAt: now, updatedAt: now, revision: 2 }
  ]
  await db.sections.bulkPut([secA, secB])
  await db.rings.bulkPut(rings)
  await db.cracks.bulkPut(cracks)
  return { secA, secB, rings, cracks }
}

async function confirmAll(orderId: string): Promise<void> {
  const order = await db.adjustments.get(orderId)
  order!.assignments.forEach((a) => (a.confirmed = true))
  order!.issues = []
  await db.adjustments.put(order!)
}

/* ------------------------------- 场景 ------------------------------- */

// 1. 拆分：1号线 1000~2000 在 1800 拆，r3(1900) 进上段；r1/r2 留下段
{
  const seed = await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'split',
    title: '拆分 A @1800',
    sourceSectionIds: ['secA'],
    splitAtMileage: 1800
  })
  const r3Assignment = order.assignments.find((a) => a.ringId === 'r3')
  check('拆分建单：r3 默认归入上段（新建区间）', r3Assignment!.targetKey !== 'secA' && r3Assignment!.crossBoundary === true)
  check('拆分建单：r1/r2 留下段且不跨界', order.assignments.filter((a) => a.ringId === 'r1' || a.ringId === 'r2').every((a) => a.targetKey === 'secA' && !a.crossBoundary))
  check('受影响裂缝仅跨界环 r3 上的 c2', order.affectedCrackIds.length === 1 && order.affectedCrackIds[0] === 'c2')

  await confirmAll(order.id)
  const applied = await applyAdjustment(order.id)
  check('拆分提交成功', applied.status === 'applied', applied.lastError)

  const r1 = await db.rings.get('r1')
  const r3 = await db.rings.get('r3')
  const c2 = await db.cracks.get('c2')
  const c1 = await db.cracks.get('c1')
  const upperId = applied.targets.find((t) => t.mode === 'create')!.sectionId
  check('r3 实体 id 不变、归属切到上段', r3!.id === 'r3' && r3!.sectionId === upperId)
  check('r3 环号里程不变', r3!.ringNo === 3 && r3!.mileage === 1900)
  check('裂缝 c2 跟随 r3，sectionId 同步上段', c2!.sectionId === upperId && c2!.ringId === 'r3')
  check('下段裂缝 c1 仍属 secA', c1!.sectionId === 'secA')
  const secANew = await db.sections.get('secA')
  const upper = await db.sections.get(upperId)
  check('下段里程缩短为 1000~1800', secANew!.startMileage === 1000 && secANew!.endMileage === 1800)
  check('上段里程 1800~2000 已建立', upper!.startMileage === 1800 && upper!.endMileage === 2000)
  check('下段环数重算为 2', secANew!.ringCount === 2)
  check('上段环数为 1', upper!.ringCount === 1)

  // 回滚
  const rolled = await rollbackAdjustment(order.id)
  check('回滚状态 recorded', rolled.status === 'rolled-back')
  const secARestored = await db.sections.get('secA')
  const r3Restored = await db.rings.get('r3')
  const c2Restored = await db.cracks.get('c2')
  check('回滚后 secA 里程回填 1000~2000', secARestored!.endMileage === 2000)
  check('回滚后 r3 回填 secA、环号里程不变', r3Restored!.sectionId === 'secA' && r3Restored!.ringNo === 3 && r3Restored!.mileage === 1900)
  check('回滚后 c2 回填 secA', c2Restored!.sectionId === 'secA')
  check('回滚后新建上段已删除', (await db.sections.get(upperId)) === undefined)
  void seed
}

// 2. 合并：secA + secB 合并为 secA 1000~3000，secB 撤销
{
  await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '合并 A+B',
    sourceSectionIds: ['secA', 'secB']
  })
  check('合并建单：仅一个存续目标', order.targets.length === 1 && order.targets[0].sectionId === 'secA')
  check('合并建单：目标里程为并集 1000~3000', order.targets[0].startMileage === 1000 && order.targets[0].endMileage === 3000)
  check('合并建单：secB 环 r4/r5 标记跨界', order.assignments.filter((a) => a.crossBoundary).map((a) => a.ringId).join() === 'r4,r5')
  await confirmAll(order.id)
  const applied = await applyAdjustment(order.id)
  check('合并提交成功', applied.status === 'applied', applied.lastError)
  const secB = await db.sections.get('secB')
  check('非存续区间 secB 已撤销', secB === undefined)
  const r4 = await db.rings.get('r4')
  const c3 = await db.cracks.get('c3')
  check('r4 迁入 secA 且环号/里程不变', r4!.sectionId === 'secA' && r4!.ringNo === 4 && r4!.mileage === 2100)
  check('裂缝 c3 跟随迁入 secA', c3!.sectionId === 'secA')
  const secA = await db.sections.get('secA')
  check('合并后环数重算为 5', secA!.ringCount === 5)

  const rolled = await rollbackAdjustment(order.id)
  check('合并回滚成功', rolled.status === 'rolled-back')
  check('回滚后 secB 恢复', (await db.sections.get('secB')) !== undefined)
  check('回滚后 r4 回填 secB', (await db.rings.get('r4'))!.sectionId === 'secB')
  check('回滚后 secA 里程回填 1000~2000', (await db.sections.get('secA'))!.endMileage === 2000)
}

// 3. 阻断：里程重叠（把合并目标终里程改到与 secB 重叠）— 用拆分 secA，目标越界与 secB 重叠
{
  await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'split',
    title: '拆分重叠',
    sourceSectionIds: ['secA'],
    splitAtMileage: 1800
  })
  order.targets[1].startMileage = 1500 // 上段改为 1500~2000，与下段 1000~1800 重叠，也与 secB 端点相邻但不重叠
  await db.adjustments.put(order)
  await confirmAll(order.id)
  // r3 里程 1900 仍落在上段；但上下段 1500~1800 重叠
  const applied = await applyAdjustment(order.id)
  const ctx = { sections: await db.sections.toArray(), rings: await db.rings.toArray(), cracks: await db.cracks.toArray() }
  const issues = validateOrder(await db.adjustments.get(order.id)!, ctx)
  check('里程重叠被检出', issues.some((i) => i.code === 'mileage-overlap'))
  check('重叠时不写入（failed）', applied.status === 'failed')
  check('现台账继续可用：secA 里程未被改动', (await db.sections.get('secA'))!.endMileage === 2000)
  check('未产生新建区间', (await db.sections.count()) === 2)
}

// 4. 阻断：环号碰撞（手工构造：secA 内 r1 ringNo=1，secB 中补一个 ringNo=1 后合并）
{
  await seedCustom()
  const now = Date.now()
  await db.rings.put({
    id: 'rCollision',
    sectionId: 'secB',
    ringNo: 1,
    mileage: 2500,
    segmentType: '钢筋混凝土',
    installDate: '2020-03-01',
    createdAt: now,
    updatedAt: now,
    revision: 2
  })
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '环号碰撞合并',
    sourceSectionIds: ['secA', 'secB']
  })
  await confirmAll(order.id)
  const applied = await applyAdjustment(order.id)
  const ctx = { sections: await db.sections.toArray(), rings: await db.rings.toArray(), cracks: await db.cracks.toArray() }
  const issues = validateOrder(await db.adjustments.get(order.id)!, ctx)
  check('环号碰撞被检出', issues.some((i) => i.code === 'ring-no-collision'))
  check('碰撞时不写入', applied.status === 'failed' && (await db.sections.get('secB')) !== undefined)
}

// 5. 阻断：环片里程不在目标区间（拆分点改到 r3 之上，r3 仍被指向上段但里程超界场景）
{
  await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'split',
    title: '超界',
    sourceSectionIds: ['secA'],
    splitAtMileage: 1800
  })
  // 把下段终里程改小到 1500，使 r2(1600) 留在下段但 1600 > 1500 → 超界
  order.targets[0].endMileage = 1500
  order.targets[1].startMileage = 1500
  await db.adjustments.put(order)
  // r2 目标仍是下段 secA，里程 1600 > 1500 → ring-out-of-range；同时 r3 在上段 1500~2000 正常
  await confirmAll(order.id)
  const applied = await applyAdjustment(order.id)
  const ctx = { sections: await db.sections.toArray(), rings: await db.rings.toArray(), cracks: await db.cracks.toArray() }
  const issues = validateOrder(await db.adjustments.get(order.id)!, ctx)
  check('环片超界被检出（迁移后找不到所属区间）', issues.some((i) => i.code === 'ring-out-of-range' && i.refRingId === 'r2'))
  check('超界时不写入', applied.status === 'failed' && (await db.sections.get('secA'))!.endMileage === 2000)
}

// 6. 阻断：未确认去向 + 孤裂缝
{
  await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '未确认',
    sourceSectionIds: ['secA', 'secB']
  })
  // 故意造一条裂缝指向不存在的环片
  const now = Date.now()
  await db.cracks.put({
    id: 'cOrphan',
    ringId: 'rGhost',
    sectionId: 'secA',
    code: 'CG',
    position: '拱顶',
    direction: '纵向',
    widthMm: 0.1,
    lengthMm: 10,
    state: '观察',
    createdAt: now,
    updatedAt: now,
    revision: 2
  })
  // 不确认任何环
  const applied = await applyAdjustment(order.id)
  const ctx = { sections: await db.sections.toArray(), rings: await db.rings.toArray(), cracks: await db.cracks.toArray() }
  const issues = validateOrder(await db.adjustments.get(order.id)!, ctx)
  check('未确认去向被检出', issues.some((i) => i.code === 'ring-unconfirmed'))
  check('孤裂缝被检出（迁移后找不到所属环片）', issues.some((i) => i.code === 'orphan-crack' && i.refCrackId === 'cOrphan'))
  check('不写入', applied.status === 'failed')
}

// 6b. 阻断：无环来源区间上的裂缝（sectionId 在来源内但环片不存在/不在调整单）
{
  await seedCustom()
  const now = Date.now()
  // 让 secB 无环（迁走其环到 secA 的里程区间外不可行），改为新建第三个无环区间 secC 参与合并
  await db.sections.put({
    id: 'secC',
    line: '1号线',
    startMileage: 3000,
    endMileage: 3200,
    structureType: '盾构',
    ringCount: 1,
    createdAt: now,
    updatedAt: now,
    revision: 2
  })
  await db.cracks.put({
    id: 'cStray',
    ringId: 'rGone',
    sectionId: 'secC',
    code: 'CS',
    position: '拱顶',
    direction: '纵向',
    widthMm: 0.1,
    lengthMm: 10,
    state: '观察',
    createdAt: now,
    updatedAt: now,
    revision: 2
  })
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '无环区间裂缝',
    sourceSectionIds: ['secA', 'secC']
  })
  await confirmAll(order.id)
  const applied = await applyAdjustment(order.id)
  const ctx = { sections: await db.sections.toArray(), rings: await db.rings.toArray(), cracks: await db.cracks.toArray() }
  const issues = validateOrder(await db.adjustments.get(order.id)!, ctx)
  check('无环来源区间的孤裂缝被检出', issues.some((i) => i.code === 'orphan-crack' && i.refCrackId === 'cStray'))
  check('孤裂缝场景不写入、现台账可用', applied.status === 'failed' && (await db.sections.get('secC')) !== undefined)
}

// 7. 断点续跑：在 applyAdjustment 迁移到一半时，通过直接修改库模拟中断
//    做法：先让第 1 环成功写入 appliedRingIds（利用钩子不可行），改为：手工把 order 置 applying、
//    只把 r1 迁好并记录进度，然后调用 applyAdjustment 应从 r2 继续。
{
  await seedCustom()
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '断点续跑',
    sourceSectionIds: ['secA', 'secB']
  })
  await confirmAll(order.id)
  // 手工推进：snapshot 先落，r1 已迁（r1 本就在 secA，记进度即可），状态 applying
  const draft = await db.adjustments.get(order.id)
  draft!.snapshot = {
    sections: (await db.sections.toArray()).map(({ revision: _r, ...s }) => s),
    rings: (await db.rings.toArray()).map(({ revision: _r, ...s }) => s),
    cracks: (await db.cracks.toArray()).map(({ revision: _r, ...s }) => s),
    removedSectionIds: ['secB']
  }
  draft!.status = 'applying'
  draft!.appliedRingIds = ['r1']
  await db.adjustments.put(draft!)
  const resumed = await applyAdjustment(order.id)
  check('断点续跑后全部完成', resumed.status === 'applied', resumed.lastError)
  check('续跑进度覆盖全部 5 环', resumed.appliedRingIds.length === 5)
  check('续跑后 secB 撤销', (await db.sections.get('secB')) === undefined)
  check('r5 完成迁入', (await db.rings.get('r5'))!.sectionId === 'secA')
}

// 8. v2 旧备份导入（无 adjustments 字段）
{
  await reset()
  await seedDatabase()
  const snapshot = await exportSnapshot()
  // 导出当前 v3；删除 adjustments 模拟旧备份，并把 dbVersion 改成 2
  const legacy = { ...snapshot, dbVersion: 2 }
  delete (legacy as Partial<typeof legacy>).adjustments
  await importSnapshot(legacy)
  check('旧备份导入成功：区间 2 个', (await db.sections.count()) === 2)
  check('旧备份导入成功：环片 5 个', (await db.rings.count()) === 5)
  check('旧备份导入成功：调整单表为空且不报错', (await db.adjustments.count()) === 0)
  // 导入旧数据后仍可发起调整（证明现台账继续可用）
  const order = await createAdjustmentOrder({
    kind: 'merge',
    title: '旧数据上合并',
    sourceSectionIds: ['sec-1', 'sec-2']
  })
  check('旧数据上可建调整单', order.id.length > 0)
}

// 9. 演示数据播种幂等
{
  await reset()
  await seedDatabase()
  await seedDatabase()
  check('播种幂等', (await db.sections.count()) === 2 && (await db.rings.count()) === 5)
}

void assert

console.log(`\n${passed} checks passed`)
