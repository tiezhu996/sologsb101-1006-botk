/**
 * 区间重划领域服务（纯函数校验 + IndexedDB 事务写入）
 *
 * 不变量：
 * 1. 环片（Ring）是实体身份，区间（Section）只是行政分段；调整时环片/裂缝/复测 id 全部不变，
 *    只迁移 sectionId，裂缝按 ringId 跟随环片，复测按 crackId 跟随裂缝，绝不换错对象。
 * 2. 提交前全量校验：里程重叠、环号碰撞、迁移后环片/裂缝找不到所属，任一命中则一条不写。
 * 3. 逐环小事务推进并把进度落盘到调整单，失败后保留调整单与已确认去向，重试从断点继续。
 * 4. 提交前对涉及的区间/环片/裂缝做快照，可一键回填原归属；复测与建议不涉及归属列，无需改动。
 */
import type { Section, StructureType } from '@/types/section'
import type { Ring } from '@/types/ring'
import {
  createId,
  db,
  type CrackRow,
  type RingRow,
  type SectionRow
} from '@/utils/db'
import type {
  AdjustmentIssue,
  AdjustmentOrder,
  AdjustmentTargetSection,
  RingAssignment
} from '@/types/adjustment'

/** 闭区间判定：里程落在区间 [start, end] 内 */
export function sectionContainsMileage(target: Pick<AdjustmentTargetSection, 'startMileage' | 'endMileage'>, m: number): boolean {
  return m >= target.startMileage && m <= target.endMileage
}

/** 严格重叠判定：仅端点相接（[a,p] 与 [p,b]）不算重叠 */
function sectionsOverlap(
  a: { line: string; startMileage: number; endMileage: number },
  b: { line: string; startMileage: number; endMileage: number }
): boolean {
  if (a.line !== b.line) return false
  return a.startMileage < b.endMileage && b.startMileage < a.endMileage
}

export interface CreateAdjustmentInput {
  kind: AdjustmentOrder['kind']
  title: string
  /** merge：参与合并的区间 id（≥2）；split：被拆分区间 id（1 个） */
  sourceSectionIds: string[]
  /** split 时的拆分里程点 */
  splitAtMileage?: number | null
}

/* ============================== 建单 ============================== */

/**
 * 按线路复检结果创建调整单（草稿）：
 * - merge：保留起点最小的区间作为存续区间，里程扩为并集；
 * - split：原区间缩短为下段（保留 id），预分配 id 新建上段。
 * 环片初始去向按里程自动建议，全部标记为待确认。
 */
export async function createAdjustmentOrder(input: CreateAdjustmentInput): Promise<AdjustmentOrder> {
  const now = Date.now()
  const sourceSections = (
    await db.sections.where('id').anyOf(input.sourceSectionIds).toArray()
  ).sort((a, b) => a.startMileage - b.startMileage)

  if (sourceSections.length === 0) throw new Error('未找到所选区间，可能已被删除')

  const sourceRings = await db.rings.where('sectionId').anyOf(input.sourceSectionIds).toArray()

  let targets: AdjustmentTargetSection[]
  let splitAt: number | null = null

  if (input.kind === 'merge') {
    if (sourceSections.length < 2) throw new Error('合并至少选择两个相邻区间')
    const survivor = sourceSections[0]
    targets = [
      {
        key: survivor.id,
        mode: 'keep',
        sectionId: survivor.id,
        line: survivor.line,
        startMileage: Math.min(...sourceSections.map((s) => s.startMileage)),
        endMileage: Math.max(...sourceSections.map((s) => s.endMileage)),
        structureType: survivor.structureType,
        survivor: true,
        sourceSectionIds: sourceSections.map((s) => s.id)
      }
    ]
  } else {
    if (sourceSections.length !== 1) throw new Error('拆分只能选择一个区间')
    const source = sourceSections[0]
    const p = Math.round(Number(input.splitAtMileage))
    if (!Number.isFinite(p) || p <= source.startMileage || p >= source.endMileage) {
      throw new Error('拆分里程点必须严格位于区间起止里程之间')
    }
    splitAt = p
    const newHighId = createId('sec')
    targets = [
      {
        key: source.id,
        mode: 'keep',
        sectionId: source.id,
        line: source.line,
        startMileage: source.startMileage,
        endMileage: p,
        structureType: source.structureType,
        survivor: true,
        sourceSectionIds: [source.id]
      },
      {
        key: newHighId,
        mode: 'create',
        sectionId: newHighId,
        line: source.line,
        startMileage: p,
        endMileage: source.endMileage,
        structureType: source.structureType,
        survivor: false,
        sourceSectionIds: [source.id]
      }
    ]
  }

  const survivorKey = targets[0].key
  const highKey = targets.length > 1 ? targets[1].key : null

  const assignments: RingAssignment[] = sourceRings
    .slice()
    .sort((a, b) => a.mileage - b.mileage || a.ringNo - b.ringNo)
    .map((ring) => {
      let targetKey: string
      if (input.kind === 'merge') {
        targetKey = survivorKey
      } else {
        // 拆分点恰落在环里程上时，该环归入上段（start === p 的区间）
        targetKey = highKey !== null && ring.mileage >= (splitAt as number) ? highKey : survivorKey
      }
      return {
        ringId: ring.id,
        fromSectionId: ring.sectionId,
        targetKey,
        // 跨界：合并时来自非存续区间的环、拆分时进入上段的环，预览置顶并要求人工确认
        crossBoundary: isCrossBoundary(input.kind, ring, targetKey, survivorKey),
        confirmed: false
      }
    })

  const crossBoundaryRingIds = assignments.filter((a) => a.crossBoundary).map((a) => a.ringId)
  const affectedCrackIds = await crackIdsOfRings(crossBoundaryRingIds)

  const order: AdjustmentOrder = {
    id: createId('adj'),
    kind: input.kind,
    status: 'draft',
    title: input.title.trim(),
    sourceSectionIds: sourceSections.map((s) => s.id),
    splitAtMileage: splitAt,
    targets,
    assignments,
    snapshot: null,
    appliedRingIds: [],
    crossBoundaryRingIds,
    affectedCrackIds,
    issues: [],
    lastError: '',
    createdAt: now,
    updatedAt: now,
    appliedAt: null
  }
  await db.adjustments.put(order)
  return order
}

/** merge 时所有环都进存续区间，跨界仅指来自非存续区间的环；split 时指进入上段的环 */
function isCrossBoundary(
  kind: AdjustmentOrder['kind'],
  ring: Ring,
  targetKey: string,
  survivorKey: string
): boolean {
  if (kind === 'merge') return ring.sectionId !== survivorKey
  return targetKey !== survivorKey
}

async function crackIdsOfRings(ringIds: string[]): Promise<string[]> {
  if (ringIds.length === 0) return []
  const cracks = await db.cracks.where('ringId').anyOf(ringIds).toArray()
  return cracks.map((c) => c.id)
}

/* ============================== 校验 ============================== */

export interface ValidationContext {
  sections: SectionRow[]
  rings: RingRow[]
  cracks: CrackRow[]
}

/**
 * 提交前全量校验（纯函数）。error 任一存在即拒绝写入；warning 仅提示。
 * 三类硬性拦截：里程重叠 / 环号碰撞 / 迁移后找不到所属环片（含环片超界、孤裂缝）。
 */
export function validateOrder(order: AdjustmentOrder, ctx: ValidationContext): AdjustmentIssue[] {
  const issues: AdjustmentIssue[] = []
  const ringById = new Map(ctx.rings.map((r) => [r.id, r]))
  const sectionById = new Map(ctx.sections.map((s) => [s.id, s]))
  const targetByKey = new Map(order.targets.map((t) => [t.key, t]))

  /* 1. 目标区间自身里程合法 */
  for (const target of order.targets) {
    if (!(target.endMileage > target.startMileage)) {
      issues.push({
        level: 'error',
        code: 'target-invalid',
        refSectionKey: target.key,
        message: `目标区间「${target.line}」起止里程非法（${target.startMileage} ≥ ${target.endMileage}）`
      })
    }
    if (target.mode === 'keep' && !sectionById.has(target.sectionId)) {
      issues.push({
        level: 'error',
        code: 'target-invalid',
        refSectionKey: target.key,
        message: `存续区间 ${target.sectionId} 已在现台账中删除，请放弃该调整单后重建`
      })
    }
  }

  /* 2. 同一线路里程严格重叠：目标之间 + 目标与未参与调整的既有区间，两两比较一次 */
  const untouched = ctx.sections.filter((s) => !order.sourceSectionIds.includes(s.id))
  const allChecks: Array<AdjustmentTargetSection | Section> = [...order.targets, ...untouched]
  for (let i = 0; i < allChecks.length; i++) {
    for (let j = i + 1; j < allChecks.length; j++) {
      const a = allChecks[i]
      const b = allChecks[j]
      if (sectionsOverlap(a, b)) {
        issues.push({
          level: 'error',
          code: 'mileage-overlap',
          refSectionKey: 'key' in a ? a.key : undefined,
          message: `同一里程落入两个区间：「${a.line} ${a.startMileage}～${a.endMileage}」与「${b.line} ${b.startMileage}～${b.endMileage}」重叠`
        })
      }
    }
  }

  /* 3. 合并非同线路提示 */
  if (order.kind === 'merge') {
    const lines = new Set(order.targets[0] ? [order.targets[0].line] : [])
    order.sourceSectionIds.forEach((id) => {
      const s = sectionById.get(id)
      if (s) lines.add(s.line)
    })
    if (lines.size > 1) {
      issues.push({
        level: 'warning',
        code: 'line-mismatch',
        message: '参与合并的区间分属不同线路，合并后请核对线路名称'
      })
    }
  }

  /* 4. 拆分点落在某环里程上提示 */
  if (order.kind === 'split' && order.splitAtMileage !== null) {
    const p = order.splitAtMileage
    if (ctx.rings.some((r) => order.sourceSectionIds.includes(r.sectionId) && r.mileage === p)) {
      issues.push({
        level: 'warning',
        code: 'boundary-touch',
        message: `拆分里程点 ${p} m 恰有环片，该环已按"归入上段"处理，请人工确认`
      })
    }
  }

  /* 5. 逐环：去向存在、里程落在目标区间内、环号不碰撞、去向已确认 */
  const ringsByTarget = new Map<string, RingRow[]>()
  for (const assignment of order.assignments) {
    const ring = ringById.get(assignment.ringId)
    const target = targetByKey.get(assignment.targetKey)
    if (!ring) {
      issues.push({
        level: 'error',
        code: 'ring-unassigned',
        refRingId: assignment.ringId,
        message: `调整单中的环片 ${assignment.ringId} 在现台账已不存在`
      })
      continue
    }
    if (!target) {
      issues.push({
        level: 'error',
        code: 'ring-unassigned',
        refRingId: ring.id,
        message: `第 ${ring.ringNo} 环没有去向区间`
      })
      continue
    }
    if (!sectionContainsMileage(target, ring.mileage)) {
      issues.push({
        level: 'error',
        code: 'ring-out-of-range',
        refRingId: ring.id,
        refSectionKey: target.key,
        message: `第 ${ring.ringNo} 环里程 ${ring.mileage} m 不在目标区间 ${target.startMileage}～${target.endMileage} 内，迁移后将找不到所属区间`
      })
    }
    const list = ringsByTarget.get(target.key) ?? []
    list.push(ring)
    ringsByTarget.set(target.key, list)
    if (!assignment.confirmed) {
      issues.push({
        level: 'error',
        code: 'ring-unconfirmed',
        refRingId: ring.id,
        refSectionKey: target.key,
        message: `第 ${ring.ringNo} 环去向尚未确认`
      })
    }
  }

  for (const [targetKey, rings] of ringsByTarget) {
    const seen = new Map<number, RingRow>()
    for (const ring of rings) {
      const prev = seen.get(ring.ringNo)
      if (prev) {
        issues.push({
          level: 'error',
          code: 'ring-no-collision',
          refRingId: ring.id,
          refSectionKey: targetKey,
          message: `环号碰撞：第 ${ring.ringNo} 环在同一新区间内重复（里程 ${prev.mileage} / ${ring.mileage} m）`
        })
      } else {
        seen.set(ring.ringNo, ring)
      }
    }
  }

  /* 6. 裂缝迁移后必须仍能找到所属环片（实体身份不变，sectionId 随环片回填） */
  const assignedRingIds = new Set(order.assignments.map((a) => a.ringId))
  const targetKeyOfRing = new Map(order.assignments.map((a) => [a.ringId, a.targetKey]))
  for (const crack of ctx.cracks) {
    // 涉及范围：在调整单环片上的裂缝，或冗余 sectionId 仍指向来源区间的裂缝（含无环来源区间）
    const ringInScope = assignedRingIds.has(crack.ringId)
    const sectionInScope = order.sourceSectionIds.includes(crack.sectionId)
    if (!ringInScope && !sectionInScope) continue
    const ring = ringById.get(crack.ringId)
    // 环片不存在 / 不在本次去向表 / 目标去向缺失，迁移后都会找不到所属环片
    const targetKey = targetKeyOfRing.get(crack.ringId)
    if (!ring || !targetKey || !targetByKey.has(targetKey)) {
      issues.push({
        level: 'error',
        code: 'orphan-crack',
        refCrackId: crack.id,
        message: `裂缝 ${crack.code} 迁移后找不到所属环片（ringId=${crack.ringId}）`
      })
    }
  }

  return issues
}

export function blockingIssues(issues: AdjustmentIssue[]): AdjustmentIssue[] {
  return issues.filter((i) => i.level === 'error')
}

/* ========================== 快照与断点提交 ========================== */

/** 生成提交前快照：涉及的区间整行 + 被迁移环片 + 这些环片上的裂缝 */
async function buildSnapshot(order: AdjustmentOrder): Promise<AdjustmentOrder['snapshot']> {
  const involvedSectionIds = new Set<string>([
    ...order.sourceSectionIds,
    ...order.targets.map((t) => t.sectionId)
  ])
  const sections = await db.sections.where('id').anyOf([...involvedSectionIds]).toArray()
  const rings =
    order.assignments.length === 0
      ? []
      : await db.rings.where('id').anyOf(order.assignments.map((a) => a.ringId)).toArray()
  const cracks =
    rings.length === 0 ? [] : await db.cracks.where('ringId').anyOf(rings.map((r) => r.id)).toArray()
  // merge 后被撤销的是「非存续」来源区间；split 不删区间（原区间缩短续用）
  const removedSectionIds =
    order.kind === 'merge'
      ? order.sourceSectionIds.filter((id) => !order.targets.some((t) => t.sectionId === id))
      : []
  return {
    sections: stripRevision(sections),
    rings: stripRevision(rings),
    cracks: stripRevision(cracks),
    removedSectionIds
  }
}

function stripRevision<T extends { revision?: number }>(rows: T[]): Array<Omit<T, 'revision'>> {
  return rows.map(({ revision: _revision, ...rest }) => rest as Omit<T, 'revision'>)
}

async function loadContext(): Promise<ValidationContext> {
  const [sections, rings, cracks] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray()
  ])
  return { sections, rings, cracks }
}

async function persistOrder(order: AdjustmentOrder): Promise<void> {
  order.updatedAt = Date.now()
  await db.adjustments.put(order)
}

/**
 * 统一提交（可重复调用实现断点续跑）：
 * - 校验失败 → 状态 failed，正式表一条不写；
 * - 逐环独立事务迁移 ring.sectionId 与同环裂缝的冗余 sectionId，进度写入 appliedRingIds；
 * - 中途失败 → 状态 failed、保留调整单/去向/已完成进度，重试跳过 appliedRingIds。
 */
export async function applyAdjustment(orderId: string): Promise<AdjustmentOrder> {
  const order = await db.adjustments.get(orderId)
  if (!order) throw new Error('调整单不存在或已被删除')
  if (order.status === 'applied') return order

  const ctx = await loadContext()
  const issues = validateOrder(order, ctx)
  order.issues = issues
  const blockers = blockingIssues(issues)
  if (blockers.length > 0) {
    order.status = 'failed'
    order.lastError = `校验未通过（${blockers.length} 项），未写入任何调整：${blockers[0].message}`
    await persistOrder(order)
    return order
  }

  if (!order.snapshot) {
    order.snapshot = await buildSnapshot(order)
  }
  order.status = 'applying'
  order.lastError = ''
  await persistOrder(order)

  try {
    /* 1. 落目标区间（新建段预分配 id 在此创建；存续段更新里程/型式） */
    for (const target of order.targets) {
      const existing = await db.sections.get(target.sectionId)
      const now = Date.now()
      const next: SectionRow = existing
        ? { ...existing, line: target.line, startMileage: target.startMileage, endMileage: target.endMileage, structureType: target.structureType, updatedAt: now }
        : {
            id: target.sectionId,
            line: target.line,
            startMileage: target.startMileage,
            endMileage: target.endMileage,
            structureType: target.structureType as StructureType,
            ringCount: 0,
            createdAt: now,
            updatedAt: now,
            revision: 2
          }
      await db.sections.put(next)
    }

    /* 2. 逐环迁移：环片改归属 + 同环裂缝冗余 sectionId 回填，进度同事务落盘 */
    const done = new Set(order.appliedRingIds)
    const rings = ctx.rings
    for (const assignment of order.assignments) {
      if (done.has(assignment.ringId)) continue
      const ring = rings.find((r) => r.id === assignment.ringId)
      const target = order.targets.find((t) => t.key === assignment.targetKey)
      if (!ring) throw new Error(`环片 ${assignment.ringId} 已不存在，迁移中止`)
      if (!target) throw new Error(`第 ${ring.ringNo} 环缺少去向区间，迁移中止`)
      const now = Date.now()
      await db.transaction('rw', db.rings, db.cracks, db.adjustments, async () => {
        await db.rings.update(ring.id, { sectionId: target.sectionId, updatedAt: now })
        const cracksOfRing = await db.cracks.where('ringId').equals(ring.id).toArray()
        if (cracksOfRing.length > 0) {
          await db.cracks.bulkPut(
            cracksOfRing.map((c) => ({ ...c, sectionId: target.sectionId, updatedAt: now }))
          )
        }
        const latest = await db.adjustments.get(order.id)
        if (latest && !latest.appliedRingIds.includes(ring.id)) {
          latest.appliedRingIds = [...latest.appliedRingIds, ring.id]
          latest.status = 'applying'
          latest.updatedAt = now
          await db.adjustments.put(latest)
        }
      })
      order.appliedRingIds = Array.from(new Set([...order.appliedRingIds, ring.id]))
    }

    /* 3. 目标区间环数按新分段重算 */
    for (const target of order.targets) {
      const count = await db.rings.where('sectionId').equals(target.sectionId).count()
      await db.sections.update(target.sectionId, { ringCount: count, updatedAt: Date.now() })
    }

    /* 4. merge：环片全部迁走后撤销非存续来源区间 */
    const removedIds =
      order.kind === 'merge'
        ? order.sourceSectionIds.filter((id) => !order.targets.some((t) => t.sectionId === id))
        : []
    for (const id of removedIds) {
      const left = await db.rings.where('sectionId').equals(id).count()
      if (left > 0) throw new Error(`原区间 ${id} 仍有 ${left} 环未迁出，未予撤销`)
      await db.sections.delete(id)
    }

    order.status = 'applied'
    order.appliedAt = Date.now()
    order.lastError = ''
    await persistOrder(order)
    return order
  } catch (err) {
    const fresh = await db.adjustments.get(order.id)
    if (fresh) {
      fresh.status = 'failed'
      fresh.lastError = err instanceof Error ? err.message : '写入失败'
      await persistOrder(fresh)
      return fresh
    }
    throw err
  }
}

/* ============================== 回滚 ============================== */

/**
 * 按提交前快照回填原归属：
 * - 区间/环片/裂缝整行还原（含环号里程），merge 撤销的区间重新建立；
 * - split/merge 新建的目标区间删除；
 * - 复测与建议 id 从未改动，天然回到原裂缝之下。
 */
export async function rollbackAdjustment(orderId: string): Promise<AdjustmentOrder> {
  const order = await db.adjustments.get(orderId)
  if (!order) throw new Error('调整单不存在或已被删除')
  if (!order.snapshot) throw new Error('该调整单尚未写入，无需回滚')

  const snapshot = order.snapshot
  const createdTargetIds = order.targets
    .filter((t) => t.mode === 'create')
    .map((t) => t.sectionId)
  const snapshotSectionIds = new Set(snapshot.sections.map((s) => s.id))

  await db.transaction(
    'rw',
    [db.sections, db.rings, db.cracks, db.surveys, db.advices, db.adjustments],
    async () => {
      await db.sections.bulkPut(snapshot.sections.map((s) => ({ ...s, revision: 2 })))
      await db.rings.bulkPut(snapshot.rings.map((r) => ({ ...r, revision: 2 })))
      await db.cracks.bulkPut(snapshot.cracks.map((c) => ({ ...c, revision: 2 })))
      // 快照里没有的目标区间是本次新建的，恢复时删除
      const toDelete = createdTargetIds.filter((id) => !snapshotSectionIds.has(id))
      if (toDelete.length > 0) await db.sections.bulkDelete(toDelete)
      const latest = await db.adjustments.get(order.id)
      if (latest) {
        latest.status = 'rolled-back'
        latest.appliedRingIds = []
        latest.lastError = ''
        latest.updatedAt = Date.now()
        await db.adjustments.put(latest)
      }
    }
  )

  const rolled = await db.adjustments.get(orderId)
  return rolled as AdjustmentOrder
}

/** 删除调整单：已实际写入且未回滚的单子不允许删除（避免丢失回滚依据） */
export async function deleteAdjustment(orderId: string): Promise<void> {
  const order = await db.adjustments.get(orderId)
  if (!order) return
  if (order.snapshot && order.status !== 'rolled-back') {
    throw new Error('调整已写入台账，请先回滚恢复原归属后再删除调整单')
  }
  await db.adjustments.delete(orderId)
}

