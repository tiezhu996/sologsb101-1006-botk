/**
 * 区间重划引擎 + 执行器冒烟测试（node + fake-indexeddb）
 * 覆盖：拆分提交、环号碰撞拒绝、里程重叠拒绝、合并吸收、裂缝/测次跟随正确、
 *      写入中断保留单据且断点续提成功。
 * 运行：npx tsx scripts/realign.smoke.ts
 */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db.ts'
import {
  buildInitialPlan,
  buildViews,
  createSplitTarget,
  hasBlockingIssue,
  mergeTarget,
  refreshSuggestions,
  validatePlan
} from '../src/utils/realign.ts'
import { applyRealignOrder, FINALIZE_KEY, RealignApplyError, RealignBlockedError } from '../src/utils/realignApply.ts'
import { unitDoneKey } from '../src/types/realign.ts'
import type { RealignOrder } from '../src/types/realign.ts'
import type { RealignScope } from '../src/utils/realign.ts'

let passed = 0
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`断言失败：${message}`)
  passed += 1
  console.log(`  ✓ ${message}`)
}

async function scopeOf(): Promise<RealignScope> {
  const [sections, rings, cracks, surveys] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray()
  ])
  return { sections, rings, cracks, surveys }
}

function makeOrder(scope: RealignScope): RealignOrder {
  const plan = buildInitialPlan(scope, 'L1')
  const now = Date.now()
  return {
    id: 'ro_test',
    name: 'L1 重划',
    line: 'L1',
    status: '草稿',
    note: '',
    targets: plan.targets,
    assignments: plan.assignments,
    snapshot: plan.snapshot,
    units: [],
    completed: [],
    lastResults: [],
    createdAt: now,
    updatedAt: now,
    appliedAt: null
  }
}

function confirmAll(order: RealignOrder): void {
  order.assignments.forEach((item) => {
    item.confirmed = true
  })
}

async function resetDb(scope: {
  sections: Array<Record<string, unknown>>
  rings: Array<Record<string, unknown>>
  cracks: Array<Record<string, unknown>>
  surveys: Array<Record<string, unknown>>
}): Promise<void> {
  await db.sections.clear()
  await db.rings.clear()
  await db.cracks.clear()
  await db.surveys.clear()
  await db.advices.clear()
  await db.realignOrders.clear()
  await db.sections.bulkPut(scope.sections as never)
  await db.rings.bulkPut(scope.rings as never)
  await db.cracks.bulkPut(scope.cracks as never)
  await db.surveys.bulkPut(scope.surveys as never)
}

const base = {
  sections: [
    { id: 'sA', line: 'L1', startMileage: 1000, endMileage: 2000, structureType: '盾构', ringCount: 3, createdAt: 1, updatedAt: 1 },
    { id: 'sB', line: 'L1', startMileage: 2000, endMileage: 3000, structureType: '明挖', ringCount: 2, createdAt: 1, updatedAt: 1 },
    { id: 'sX', line: 'L2', startMileage: 0, endMileage: 900, structureType: '盾构', ringCount: 0, createdAt: 1, updatedAt: 1 }
  ],
  rings: [
    { id: 'r1', sectionId: 'sA', ringNo: 1, mileage: 1100, segmentType: '钢筋混凝土', installDate: '2020-01-01', createdAt: 1, updatedAt: 1 },
    { id: 'r2', sectionId: 'sA', ringNo: 2, mileage: 1500, segmentType: '钢筋混凝土', installDate: '2020-01-02', createdAt: 1, updatedAt: 1 },
    { id: 'r3', sectionId: 'sA', ringNo: 3, mileage: 1900, segmentType: '钢筋混凝土', installDate: '2020-01-03', createdAt: 1, updatedAt: 1 },
    { id: 'r4', sectionId: 'sB', ringNo: 4, mileage: 2100, segmentType: '铸铁', installDate: '2020-02-01', createdAt: 1, updatedAt: 1 },
    { id: 'r5', sectionId: 'sB', ringNo: 5, mileage: 2600, segmentType: '铸铁', installDate: '2020-02-02', createdAt: 1, updatedAt: 1 }
  ],
  cracks: [
    { id: 'c1', ringId: 'r1', sectionId: 'sA', code: 'C1', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 100, state: '观察', createdAt: 1, updatedAt: 1 },
    { id: 'c3', ringId: 'r3', sectionId: 'sA', code: 'C3', position: '侧墙', direction: '环向', widthMm: 0.3, lengthMm: 200, state: '待整治', createdAt: 1, updatedAt: 1 },
    { id: 'c4', ringId: 'r4', sectionId: 'sB', code: 'C4', position: '道床', direction: '斜向', widthMm: 0.4, lengthMm: 300, state: '观察', createdAt: 1, updatedAt: 1 }
  ],
  surveys: [
    { id: 'v1', crackId: 'c1', seq: 1, date: '2024-01-01', widthMm: 0.2, lengthMm: 100, deltaWidthMm: 0, surveyor: '甲', createdAt: 1, updatedAt: 1 },
    { id: 'v2', crackId: 'c1', seq: 2, date: '2024-02-01', widthMm: 0.24, lengthMm: 110, deltaWidthMm: 0.04, surveyor: '甲', createdAt: 1, updatedAt: 1 },
    { id: 'v3', crackId: 'c4', seq: 1, date: '2024-03-01', widthMm: 0.4, lengthMm: 300, deltaWidthMm: 0, surveyor: '乙', createdAt: 1, updatedAt: 1 }
  ]
}

async function main(): Promise<void> {
  await db.open()

  /* ---- 用例 1：在 1600 拆分 sA，r3 跨界迁入新区间，提交成功 ---- */
  console.log('用例 1：里程点拆分 + 跨界迁移')
  await resetDb(base)
  let scope = await scopeOf()
  let order = makeOrder(scope)
  assert(order.targets.length === 2, '初始方案只含 L1 的两个区间（不含 L2）')

  const tNew = createSplitTarget('L1', '盾构')
  tNew.startMileage = 1600
  tNew.endMileage = 2000
  order.targets = order.targets.map((t) => (t.sectionId === 'sA' ? { ...t, endMileage: 1600 } : t))
  order.targets.push(tNew)
  order.assignments = refreshSuggestions(order.targets, order.assignments, scope.rings)

  const previews = buildViews(order, scope)
  const cross = previews.rings.filter((r) => r.crossBoundary).map((r) => r.ring.id)
  assert(cross.includes('r3'), 'r3 被识别为跨界环片')
  assert(!cross.includes('r1'), 'r1 不跨界')
  assert(previews.rings.find((r) => r.ring.id === 'r3')?.surveyCount === 0, 'r3 无测次，预览测次数为 0')
  assert(previews.rings.find((r) => r.ring.id === 'r1')?.surveyCount === 2, 'r1 受影响测次为 2')

  // 全部确认前应阻塞
  let issues = validatePlan(order, scope)
  assert(hasBlockingIssue(issues), '未确认去向前提交被阻塞')

  confirmAll(order)
  issues = validatePlan(order, scope)
  assert(!hasBlockingIssue(issues), '全部确认且无冲突后校验通过')

  await db.realignOrders.put({ ...order, revision: 3 })
  const outcome = await applyRealignOrder(
    order,
    scope,
    (o, s) => validatePlan(o, s).filter((i) => i.level === 'error')
  )
  assert(outcome.completed && outcome.order.status === '已提交', '执行完成并置为已提交')

  const r3 = await db.rings.get('r3')
  const c3 = await db.cracks.get('c3')
  const r1 = await db.rings.get('r1')
  const c1 = await db.cracks.get('c1')
  assert(r3?.sectionId === `sec_new_${tNew.key.slice(4)}`, 'r3 迁入拆分新区间')
  assert(c3?.sectionId === r3?.sectionId, '裂缝 c3 随环片同步 sectionId，ringId 仍为 r3')
  assert(c3?.ringId === 'r3', '裂缝环片身份不变')
  assert(r1?.sectionId === 'sA', 'r1 留在原区间')
  assert(c1?.sectionId === 'sA', 'c1 归属仍为 sA')
  const v1 = await db.surveys.get('v1')
  const v2 = await db.surveys.get('v2')
  assert(v1?.crackId === 'c1' && v2?.crackId === 'c1', '复测记录完全不动')
  const newSec = await db.sections.get(`sec_new_${tNew.key.slice(4)}`)
  assert(!!newSec && newSec.startMileage === 1600 && newSec.endMileage === 2000, '拆分区间已创建')
  const sA = await db.sections.get('sA')
  assert(sA?.endMileage === 1600 && sA?.ringCount === 2, '原区间里程收缩、环数重算为 2')
  assert(newSec?.ringCount === 1, '新区间环数为 1')

  /* ---- 用例 2：环号碰撞 → 整单不写入 ---- */
  console.log('用例 2：环号碰撞拒绝写入')
  await resetDb(base)
  scope = await scopeOf()
  order = makeOrder(scope)
  confirmAll(order)
  order.assignments.find((a) => a.ringId === 'r4')!.newRingNo = 5 // r4、r5 都变成 5
  let blocked = false
  try {
    await applyRealignOrder(
      order,
      scope,
      (o, s) => validatePlan(o, s).filter((i) => i.level === 'error')
    )
  } catch (e) {
    blocked = e instanceof RealignBlockedError
  }
  assert(blocked, '环号碰撞抛出 RealignBlockedError')
  const r4 = await db.rings.get('r4')
  assert(r4?.ringNo === 4 && r4?.sectionId === 'sB', '现台账保持可用（环号/归属未变）')
  assert((await db.realignOrders.count()) === 0, '阻塞时不产生写入（调整单由界面另行保存）')

  /* ---- 用例 3：里程重叠 → 拒绝 ---- */
  console.log('用例 3：同一里程落入两个区间')
  await resetDb(base)
  scope = await scopeOf()
  order = makeOrder(scope)
  order.targets.find((t) => t.sectionId === 'sA')!.endMileage = 2200 // 与 sB(2000~3000) 重叠
  order.assignments = refreshSuggestions(order.targets, order.assignments, scope.rings)
  confirmAll(order)
  issues = validatePlan(order, scope)
  assert(issues.some((i) => i.code === 'mileage-overlap'), '报告里程重叠')
  assert(hasBlockingIssue(issues), '里程重叠阻塞提交')

  /* ---- 用例 4：合并 sB 进 sA，提交后 sB 删除、环片裂缝随迁 ---- */
  console.log('用例 4：相邻区间合并吸收')
  await resetDb(base)
  scope = await scopeOf()
  order = makeOrder(scope)
  order.targets.find((t) => t.sectionId === 'sA')!.endMileage = 3000
  const merged = mergeTarget(order.targets, order.assignments, 'sB', 'sA')
  order.targets = merged.targets
  order.assignments = merged.assignments
  assert(order.targets.find((t) => t.sectionId === 'sA')?.absorbedSectionIds.includes('sB'), 'sA 标记吸收 sB')
  assert(
    order.assignments.find((a) => a.ringId === 'r4')?.targetKey === 'sA' &&
      !order.assignments.find((a) => a.ringId === 'r4')?.confirmed,
    'r4 改挂 sA 且需重新确认'
  )
  confirmAll(order)
  // 合并后 sA 内环号 1..5 互不冲突（原 sA 1-3，sB 4-5）
  issues = validatePlan(order, scope)
  assert(!hasBlockingIssue(issues), '合并后无阻塞冲突')
  await db.realignOrders.put({ ...order, revision: 3 })
  await applyRealignOrder(order, scope, (o, s) => validatePlan(o, s).filter((i) => i.level === 'error'))
  assert(!(await db.sections.get('sB')), '被吸收区间 sB 已删除')
  const r5 = await db.rings.get('r5')
  const c4 = await db.cracks.get('c4')
  assert(r5?.sectionId === 'sA', 'r5 已并入 sA')
  assert(c4?.sectionId === 'sA' && c4.ringId === 'r4', 'c4 随 r4 并入 sA')
  assert((await db.sections.get('sA'))?.ringCount === 5, '合并后 sA 环数为 5')

  /* ---- 用例 5：写入中断 → 状态失败、保留断点 → 重试成功 ---- */
  console.log('用例 5：断点续提')
  await resetDb(base)
  scope = await scopeOf()
  order = makeOrder(scope)
  // r2 跨界迁到 sB（里程调到 2500），制造多个 ring-update 单元
  order.assignments.find((a) => a.ringId === 'r2')!.targetKey = 'sB'
  order.assignments.find((a) => a.ringId === 'r2')!.newMileage = 2500
  confirmAll(order)
  await db.realignOrders.put({ ...order, revision: 3 })

  const origRingsPut = db.rings.put.bind(db.rings)
  let failedOnce = false
  db.rings.put = ((...args: unknown[]) => {
    const row = args[0] as { id?: string }
    if (!failedOnce && row?.id === 'r2') {
      failedOnce = true
      return Promise.reject(new Error('模拟写入冲突'))
    }
    return origRingsPut(...(args as never))
  }) as typeof db.rings.put

  let applyErr: unknown = null
  try {
    await applyRealignOrder(order, scope, (o, s) => validatePlan(o, s).filter((i) => i.level === 'error'))
  } catch (e) {
    applyErr = e
  }
  db.rings.put = origRingsPut
  assert(applyErr instanceof RealignApplyError, 'r2 写入失败抛出 RealignApplyError')

  const saved = (await db.realignOrders.get('ro_test')) as RealignOrder
  assert(saved.status === '提交失败', '调整单状态为提交失败')
  const completedKeys = saved.units
    .filter((u) => saved.completed.includes(unitDoneKey(u)))
    .map((u) => unitDoneKey(u))
  assert(completedKeys.includes('section-upsert:sA'), '已完成的区间单元记录在断点中')
  assert(!completedKeys.includes('ring-update:r2'), '失败单元标记为未完成')
  assert(saved.assignments.every((a) => a.confirmed), '已确认去向全部保留')

  // 现台账可用：r1 若已被迁移也是合法终态；r2 仍未迁移
  const r2AfterFail = await db.rings.get('r2')
  assert(r2AfterFail?.sectionId === 'sA', '失败单元 r2 未被部分写入，仍是原归属')

  // 重试（从断点继续）
  const retry = await applyRealignOrder(
    saved,
    await scopeOf(),
    (o, s) => validatePlan(o, s).filter((i) => i.level === 'error')
  )
  assert(retry.completed && retry.order.status === '已提交', '断点续提后完成')
  const r2Final = await db.rings.get('r2')
  assert(r2Final?.sectionId === 'sB' && r2Final.mileage === 2500, 'r2 续提成功迁入 sB')
  const cOfR2 = await db.cracks.where('ringId').equals('r2').toArray()
  assert(cOfR2.every((c) => c.sectionId === 'sB'), 'r2 裂缝归属已同步')
  assert(retry.order.completed.includes(FINALIZE_KEY), '收尾环数重算已完成')
  const sBFinal = await db.sections.get('sB')
  assert(sBFinal?.ringCount === 3, '续提后环数重算正确（sB=3）')

  /* ---- 用例 6：裂缝找不到所属环片（孤儿裂缝）→ 拒绝 ---- */
  console.log('用例 6：孤儿裂缝拒绝迁移')
  await resetDb(base)
  scope = await scopeOf()
  // 台账中 r5 被外部删除但裂缝存在（制造脏数据：c4.ringId=r4 仍在；再加一个指向不存在环片的裂缝）
  await db.cracks.put({
    id: 'cGhost',
    ringId: 'rGhost',
    sectionId: 'sB',
    code: 'CG',
    position: '拱顶',
    direction: '纵向',
    widthMm: 0.1,
    lengthMm: 10,
    state: '观察',
    createdAt: 1,
    updatedAt: 1
  })
  scope = await scopeOf()
  order = makeOrder(scope)
  confirmAll(order)
  issues = validatePlan(order, scope)
  assert(issues.some((i) => i.code === 'crack-orphan'), '报告裂缝找不到所属环片')
  assert(hasBlockingIssue(issues), '孤儿裂缝阻塞提交')

  await db.close()
  console.log(`\n全部通过：${passed} 项断言`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
