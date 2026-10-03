/**
 * 区间重划执行器：逐单元写入、逐单元落进度，失败可从上次停止处继续。
 *
 * 设计要点：
 * - 每个执行单元独立事务，成功后立刻把单元 key 记入 order.completed 并回写 realignOrders；
 *   任一单元失败：状态置「提交失败」，保留调整单、已确认去向与 completed，现台账保持可用；
 * - 重试只重放未完成单元（幂等：区间用确定性 id put、环片 update 为终态赋值）；
 * - 裂缝的 sectionId 冗余列随环片归属在同一事务同步，复测记录不动；
 * - 全部单元成功后统一重算区间环数并把调整单置「已提交」。
 */
import { db } from '@/utils/db'
import type {
  RealignOrder,
  RealignUnit,
  RealignUnitResult
} from '@/types/realign'
import { unitDoneKey } from '@/types/realign'
import { expandUnits, type RealignScope } from '@/utils/realign'

export const FINALIZE_KEY = 'finalize:ring-counts'

/** 校验阶段拒绝提交时抛出（调用方负责把问题展示给用户，不写入任何数据） */
export class RealignBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RealignBlockedError'
  }
}

/** 执行阶段单单元失败：调整单已置「提交失败」，可直接重试 */
export class RealignApplyError extends Error {
  readonly unit: RealignUnit
  readonly causeDetail: string

  constructor(unit: RealignUnit, detail: string) {
    super(`重划执行中断于 ${unit.kind}:${unit.refId}：${detail}`)
    this.name = 'RealignApplyError'
    this.unit = unit
    this.causeDetail = detail
  }
}

export interface ApplyOutcome {
  order: RealignOrder
  /** 本次实际执行（非跳过）的单元结果 */
  executed: RealignUnitResult[]
  resumed: boolean
  completed: boolean
}

/**
 * 提交/重试调整单。
 * @param order 调整单（含已确认去向）
 * @param scope 提交时的最新台账数据（重新展开单元，保证重试基于现状）
 * @param validate 调用方提供的校验函数（返回错误信息数组，非空则整单拒绝写入）
 */
export async function applyRealignOrder(
  order: RealignOrder,
  scope: RealignScope,
  validate: (order: RealignOrder, scope: RealignScope) => { message: string }[]
): Promise<ApplyOutcome> {
  // 提交前再校验：有阻塞问题时一个字节都不写
  const problems = validate(order, scope)
  if (problems.length > 0) {
    throw new RealignBlockedError(problems.map((item) => item.message).join('；'))
  }

  const units = expandUnits(order, scope)
  const done = new Set(order.completed)
  const executed: RealignUnitResult[] = []
  const resumed = done.size > 0

  for (const unit of units) {
    const key = unitDoneKey(unit)
    if (done.has(key)) continue
    try {
      await runUnit(unit)
      done.add(key)
      order.completed = Array.from(done)
      order.units = units
      order.status = '提交失败' // 尚未全部完成前的中间态：保证中途掉电也是可重试状态
      order.updatedAt = Date.now()
      await persistOrder(order)
      executed.push({ kind: unit.kind, refId: unit.refId, done: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知写入错误'
      order.status = '提交失败'
      order.units = units
      order.updatedAt = Date.now()
      order.lastResults = [
        ...executed,
        { kind: unit.kind, refId: unit.refId, done: false, error: detail }
      ]
      await persistOrder(order).catch(() => undefined)
      throw new RealignApplyError(unit, detail)
    }
  }

  // 收尾：重算受影响区间的环数（幂等）
  if (!done.has(FINALIZE_KEY)) {
    try {
      await recalculateSectionRingCounts(scope)
      done.add(FINALIZE_KEY)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '环数重算失败'
      order.status = '提交失败'
      order.completed = Array.from(done)
      order.units = units
      order.updatedAt = Date.now()
      order.lastResults = [{ kind: 'ring-update', refId: FINALIZE_KEY, done: false, error: detail }]
      await persistOrder(order).catch(() => undefined)
      throw new RealignApplyError({ kind: 'ring-update', refId: FINALIZE_KEY }, detail)
    }
  }

  order.status = '已提交'
  order.units = units
  order.completed = Array.from(done)
  order.appliedAt = Date.now()
  order.updatedAt = Date.now()
  order.lastResults = executed
  await persistOrder(order)

  return { order, executed, resumed, completed: true }
}

async function persistOrder(order: RealignOrder): Promise<void> {
  await db.realignOrders.put({ ...order, revision: 3 })
}

/** 执行单个幂等单元（独立事务，失败后已完成单元不会被回滚，可断点续提） */
async function runUnit(unit: RealignUnit): Promise<void> {
  if (unit.kind === 'section-upsert') {
    const payload = unit.payload ?? {}
    const sectionId = String(payload.sectionId || '')
    if (!sectionId) throw new Error('目标区间缺少 id')
    const now = Date.now()
    const existing = await db.sections.get(sectionId)
    await db.transaction('rw', db.sections, async () => {
      await db.sections.put({
        id: sectionId,
        line: String(payload.line),
        startMileage: Number(payload.startMileage),
        endMileage: Number(payload.endMileage),
        structureType: payload.structureType as never,
        ringCount: existing?.ringCount ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    })
    return
  }

  if (unit.kind === 'ring-update') {
    const payload = unit.payload ?? {}
    const ringId = unit.refId
    const targetSectionId = String(payload.sectionId)
    const now = Date.now()
    await db.transaction('rw', db.rings, db.cracks, async () => {
      const ring = await db.rings.get(ringId)
      if (!ring) throw new Error(`环片 ${ringId} 已不存在`)
      await db.rings.put({
        ...ring,
        sectionId: targetSectionId,
        ringNo: Number(payload.ringNo),
        mileage: Number(payload.mileage),
        updatedAt: now
      })
      // 环片实体身份不变 → 裂缝 ringId 不动，只同步区间冗余列，复测记录完全不动
      await db.cracks.where('ringId').equals(ringId).modify({ sectionId: targetSectionId, updatedAt: now })
    })
    return
  }

  if (unit.kind === 'section-delete') {
    await db.transaction('rw', db.sections, db.rings, async () => {
      // 删除前兜底：若仍有环片指向该区间（方案外新增等），拒绝删除，避免产生孤儿环片
      const remaining = await db.rings.where('sectionId').equals(unit.refId).count()
      if (remaining > 0) throw new Error(`区间 ${unit.refId} 仍有 ${remaining} 环未迁出`)
      await db.sections.delete(unit.refId)
    })
  }
}

/** 重算方案涉及线路内全部区间的环数（纯计数，幂等） */
async function recalculateSectionRingCounts(_scope: RealignScope): Promise<void> {
  await db.transaction('rw', db.sections, db.rings, async () => {
    const sections = await db.sections.toArray()
    for (const section of sections) {
      const count = await db.rings.where('sectionId').equals(section.id).count()
      if (section.ringCount !== count) {
        await db.sections.update(section.id, { ringCount: count, updatedAt: Date.now() })
      }
    }
  })
}
