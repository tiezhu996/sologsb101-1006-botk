/**
 * 区间重划引擎：方案构建、跨界预览、提交校验、执行单元展开与断点续提。
 * 纯函数 + 少量 Dexie 读写，不依赖 Vue，便于单测与在页面/store 中复用。
 *
 * 身份原则（与 types/realign.ts 头注释一致）：
 * - Ring.id 不变，只改 sectionId / ringNo / mileage；
 * - Crack 跟着 ringId 走，仅同步 sectionId 冗余列；
 * - Survey 只挂 crackId，重划完全不动。
 */
import type { Ring } from '@/types/ring'
import type { Section, StructureType } from '@/types/section'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type {
  RealignIssue,
  RealignOrder,
  RealignSnapshot,
  RealignTarget,
  RealignUnit,
  RingAssignment
} from '@/types/realign'

/** 参与一次重划的当前台账数据 */
export interface RealignScope {
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  surveys: Survey[]
}

/** 环片行的界面派生信息（跨界/去向/裂缝测次） */
export interface RingAssignmentView {
  assignment: RingAssignment
  ring: Ring
  fromSection: Section | null
  toTarget: RealignTarget | null
  /** 是否跨越了旧区间边界（sectionId 变化） */
  crossBoundary: boolean
  cracks: Crack[]
  surveyCount: number
  /** 新里程是否落入目标区间里程范围 */
  mileageFits: boolean
  /** 目标区间内是否与别的环片环号碰撞 */
  collision: boolean
}

/** 目标区间行的界面派生信息 */
export interface TargetView {
  target: RealignTarget
  /** 被吸收的旧区间 */
  absorbedSections: Section[]
  assignedRings: RingAssignmentView[]
  /** 该目标内的环号集合，用于碰撞提示 */
}

/* ============================== 方案初始化 ============================== */

/**
 * 以指定线路的全部既有区间为基准生成初始方案：
 * 每个区间一个 existing 目标，环片按里程给出建议去向（不自动确认）。
 */
export function buildInitialPlan(scope: RealignScope, line: string): {
  targets: RealignTarget[]
  assignments: RingAssignment[]
  snapshot: RealignSnapshot
} {
  const lineSections = scope.sections
    .filter((section) => section.line === line)
    .sort((a, b) => a.startMileage - b.startMileage)

  const targets: RealignTarget[] = lineSections.map((section) => ({
    key: section.id,
    kind: 'existing',
    sectionId: section.id,
    line: section.line,
    startMileage: section.startMileage,
    endMileage: section.endMileage,
    structureType: section.structureType,
    absorbedSectionIds: []
  }))

  const lineSectionIds = new Set(lineSections.map((section) => section.id))
  const lineRings = scope.rings
    .filter((ring) => lineSectionIds.has(ring.sectionId))
    .sort((a, b) => a.mileage - b.mileage || a.ringNo - b.ringNo)

  const assignments: RingAssignment[] = lineRings.map((ring) => {
    const suggested = suggestTarget(targets, ring.mileage, ring.sectionId)
    return {
      ringId: ring.id,
      targetKey: suggested,
      newRingNo: ring.ringNo,
      newMileage: ring.mileage,
      confirmed: false
    }
  })

  const snapshot: RealignSnapshot = {
    sections: lineSections.map((section) => ({
      id: section.id,
      line: section.line,
      startMileage: section.startMileage,
      endMileage: section.endMileage,
      structureType: section.structureType,
      ringCount: section.ringCount
    })),
    rings: lineRings.map((ring) => ({
      id: ring.id,
      sectionId: ring.sectionId,
      ringNo: ring.ringNo,
      mileage: ring.mileage
    }))
  }

  return { targets, assignments, snapshot }
}

/**
 * 建议去向：优先选择「原里程」落在哪个目标里；同一里程落入两个区间时返回 null
 * （「同一里程落入两个区间」不允许系统猜测，必须人工确认）；都不含则返回原区间。
 * 注意：建议依据是环片当前里程（ring.mileage），编辑中的新里程由人工逐环调整，不反推建议。
 */
export function suggestTarget(targets: RealignTarget[], mileage: number, fallbackKey: string | null): string | null {
  const alive = targets.filter((target) => !target.removed)
  const covering = alive.filter((target) => mileage >= target.startMileage && mileage <= target.endMileage)
  if (covering.length > 1) return null
  if (covering.length === 1) return covering[0].key
  return alive.some((target) => target.key === fallbackKey) ? fallbackKey : alive[0]?.key ?? null
}

/* ============================== 方案编辑动作 ============================== */

let targetSeq = 0

/** 新增一个拆分目标（在某个里程点拆开时使用） */
export function createSplitTarget(line: string, structureType: StructureType | string): RealignTarget {
  targetSeq += 1
  return {
    key: `new_${Date.now().toString(36)}_${targetSeq}`,
    kind: 'new',
    sectionId: '',
    line,
    startMileage: 0,
    endMileage: 0,
    structureType,
    absorbedSectionIds: []
  }
}

/** 按原里程批量刷新建议去向（用户调整区间里程或拆分点后调用），已人工确认的行不动 */
export function refreshSuggestions(targets: RealignTarget[], assignments: RingAssignment[], rings: Ring[]): RingAssignment[] {
  const ringById = new Map(rings.map((ring) => [ring.id, ring]))
  return assignments.map((item) => {
    if (item.confirmed) return item
    const ring = ringById.get(item.ringId)
    if (!ring) return item
    const suggested = suggestTarget(targets, ring.mileage, ring.sectionId)
    return { ...item, targetKey: suggested }
  })
}

/** 新增拆分目标在提交时使用的确定性区间 id（重试时幂等） */
export function newSectionId(targetKey: string): string {
  return `sec_new_${targetKey.startsWith('new_') ? targetKey.slice(4) : targetKey}`
}

/**
 * 合并目标区间：把 source 吸收进 dest。
 * - source 从方案目标中移除，其 sectionId 记入 dest.absorbedSectionIds（提交时删除区间行本身）；
 * - 指向 source 的环片去向改挂 dest，保留新环号/里程但需重新确认。
 */
export function mergeTarget(
  targets: RealignTarget[],
  assignments: RingAssignment[],
  sourceKey: string,
  destKey: string
): { targets: RealignTarget[]; assignments: RingAssignment[] } {
  const source = targets.find((target) => target.key === sourceKey)
  const dest = targets.find((target) => target.key === destKey)
  if (!source || !dest || sourceKey === destKey) return { targets, assignments }
  const nextTargets = targets
    .filter((target) => target.key !== sourceKey)
    .map((target) =>
      target.key === destKey && source.kind === 'existing' && !target.absorbedSectionIds.includes(source.sectionId)
        ? { ...target, absorbedSectionIds: [...target.absorbedSectionIds, source.sectionId] }
        : target
    )
  const nextAssignments = assignments.map((item) =>
    item.targetKey === sourceKey ? { ...item, targetKey: destKey, confirmed: false } : item
  )
  return { targets: nextTargets, assignments: nextAssignments }
}

/* ============================== 预览派生 ============================== */

export function buildViews(
  order: Pick<RealignOrder, 'targets' | 'assignments'>,
  scope: RealignScope
): { targets: TargetView[]; rings: RingAssignmentView[] } {
  const aliveTargets = order.targets.filter((target) => !target.removed)
  const sectionById = new Map(scope.sections.map((section) => [section.id, section]))
  const ringById = new Map(scope.rings.map((ring) => [ring.id, ring]))
  const cracksByRing = new Map<string, Crack[]>()
  scope.cracks.forEach((crack) => {
    const list = cracksByRing.get(crack.ringId)
    if (list) list.push(crack)
    else cracksByRing.set(crack.ringId, [crack])
  })
  const surveyCountByCrack = new Map<string, number>()
  scope.surveys.forEach((survey) => {
    surveyCountByCrack.set(survey.crackId, (surveyCountByCrack.get(survey.crackId) ?? 0) + 1)
  })

  const targetByKey = new Map(aliveTargets.map((target) => [target.key, target]))

  // 先算每个目标的环号占用，标记碰撞
  const ringNoOwners = new Map<string, Map<number, string[]>>()
  order.assignments.forEach((item) => {
    if (!item.targetKey) return
    const bucket = ringNoOwners.get(item.targetKey) ?? new Map<number, string[]>()
    const owners = bucket.get(item.newRingNo) ?? []
    owners.push(item.ringId)
    bucket.set(item.newRingNo, owners)
    ringNoOwners.set(item.targetKey, bucket)
  })

  const ringViews: RingAssignmentView[] = order.assignments.map((assignment) => {
    const ring = ringById.get(assignment.ringId) ?? null
    const fromSection = ring ? sectionById.get(ring.sectionId) ?? null : null
    const toTarget = assignment.targetKey ? targetByKey.get(assignment.targetKey) ?? null : null
    const cracks = ring ? cracksByRing.get(ring.id) ?? [] : []
    const surveyCount = cracks.reduce((sum, crack) => sum + (surveyCountByCrack.get(crack.id) ?? 0), 0)
    const mileageFits = toTarget
      ? assignment.newMileage >= toTarget.startMileage && assignment.newMileage <= toTarget.endMileage
      : false
    const owners = assignment.targetKey
      ? ringNoOwners.get(assignment.targetKey)?.get(assignment.newRingNo) ?? []
      : []
    return {
      assignment,
      ring: ring as Ring,
      fromSection,
      toTarget,
      crossBoundary: !!ring && !!toTarget && toTarget.sectionId !== ring.sectionId,
      cracks,
      surveyCount,
      mileageFits,
      collision: owners.length > 1
    }
  })

  const targetViews: TargetView[] = aliveTargets.map((target) => ({
    target,
    absorbedSections: target.absorbedSectionIds
      .map((id) => sectionById.get(id))
      .filter((section): section is Section => !!section),
    assignedRings: ringViews.filter((view) => view.assignment.targetKey === target.key)
  }))

  return { targets: targetViews, rings: ringViews }
}

/* ============================== 提交校验 ============================== */

/**
 * 提交前全量校验。任一 level=error 的问题存在时，调用方必须拒绝写入。
 * 覆盖需求的三类硬性冲突：同一里程落入两个区间、环号碰撞、数据迁移后找不到所属环片。
 */
export function validatePlan(order: Pick<RealignOrder, 'targets' | 'assignments' | 'snapshot'>, scope: RealignScope): RealignIssue[] {
  const issues: RealignIssue[] = []
  const aliveTargets = order.targets.filter((target) => !target.removed)
  const targetByKey = new Map(aliveTargets.map((target) => [target.key, target]))
  const sectionById = new Map(scope.sections.map((section) => [section.id, section]))
  const ringById = new Map(scope.rings.map((ring) => [ring.id, ring]))

  // 1. 目标区间自身里程非法
  aliveTargets.forEach((target) => {
    if (!(target.endMileage > target.startMileage)) {
      issues.push({
        level: 'error',
        code: 'target-invalid-range',
        message: `目标区间「${targetLabel(target)}」起止里程非法（止程须大于起程）`,
        refKey: target.key
      })
    }
    // 沿用区间不允许改线（跨界改线不属于重划）
    if (target.kind === 'existing' && target.sectionId) {
      const origin = sectionById.get(target.sectionId)
      if (origin && origin.line !== target.line) {
        issues.push({
          level: 'error',
          code: 'section-touch-crossline',
          message: `区间「${origin.line}」不能在重划中调整到其它线路`,
          refKey: target.key
        })
      }
      if (!origin) {
        issues.push({
          level: 'error',
          code: 'section-missing',
          message: '原台账区间已不存在，请重新生成调整方案',
          refKey: target.key
        })
      }
    }
  })

  // 2. 同一线路内里程重叠（「同一里程落入两个区间」）。
  //    端点相接（A.end == B.start）允许：行政分段连续；恰好压在分界点的环片
  //    会在建议去向时返回 null，必须人工指派。
  const sorted = [...aliveTargets].sort((a, b) => a.startMileage - b.startMileage)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (a.line === b.line && b.startMileage < a.endMileage && a.startMileage < b.endMileage) {
        issues.push({
          level: 'error',
          code: 'mileage-overlap',
          message: `「${targetLabel(a)}」与「${targetLabel(b)}」里程重叠，里程 ${b.startMileage} 同时落入两个区间`,
          refKey: a.key
        })
      }
    }
  }

  // 3. 环片去向：未确认 / 无去向 / 里程越界 / 环号碰撞
  const ringNoSeen = new Map<string, Map<number, string>>()
  order.assignments.forEach((assignment) => {
    const ring = ringById.get(assignment.ringId)
    if (!ring) {
      issues.push({
        level: 'error',
        code: 'crack-orphan',
        message: `环片 ${assignment.ringId} 在现台账中已不存在，迁移后裂缝将找不到所属环片`,
        refKey: assignment.ringId
      })
      return
    }
    if (!assignment.confirmed) {
      issues.push({
        level: 'error',
        code: 'ring-unassigned',
        message: `第 ${ring.ringNo} 环（${ring.mileage}m）去向尚未确认`,
        refKey: ring.id
      })
    }
    const target = assignment.targetKey ? targetByKey.get(assignment.targetKey) : null
    if (!target) {
      issues.push({
        level: 'error',
        code: 'ring-unassigned',
        message: `第 ${ring.ringNo} 环未指定去向区间`,
        refKey: ring.id
      })
      return
    }
    if (assignment.newMileage < target.startMileage || assignment.newMileage > target.endMileage) {
      issues.push({
        level: 'error',
        code: 'ring-out-of-range',
        message: `第 ${ring.ringNo} 环新里程 ${assignment.newMileage}m 不在「${targetLabel(target)}」里程范围内`,
        refKey: ring.id
      })
    }
    const bucket = ringNoSeen.get(target.key) ?? new Map<number, string>()
    const otherRingId = bucket.get(assignment.newRingNo)
    if (otherRingId) {
      issues.push({
        level: 'error',
        code: 'ring-no-collision',
        message: `「${targetLabel(target)}」内第 ${assignment.newRingNo} 环环号碰撞（${otherRingId} / ${ring.id}）`,
        refKey: ring.id
      })
    } else {
      bucket.set(assignment.newRingNo, ring.id)
      ringNoSeen.set(target.key, bucket)
    }
  })

  // 4. 数据完整性：现台账已有裂缝/复测在迁移后必须仍能找到所属环片。
  //    本方案的环片集合 = 调整单定格快照内的环片；若现台账中同线路还存在快照外环片
  //    （例如他人/他标签页新增），其裂缝在目标方案中没有去向，拒绝写入。
  const assignedRingIds = new Set(order.assignments.map((item) => item.ringId))
  const snapshotSectionIds = new Set(order.snapshot.sections.map((section) => section.id))
  scope.rings.forEach((ring) => {
    if (snapshotSectionIds.has(ring.sectionId) && !assignedRingIds.has(ring.id)) {
      issues.push({
        level: 'error',
        code: 'crack-orphan',
        message: `第 ${ring.ringNo} 环不在调整方案内，迁移后其裂缝将找不到所属环片，请重建调整单`,
        refKey: ring.id
      })
    }
  })
  scope.cracks.forEach((crack) => {
    const ring = ringById.get(crack.ringId)
    if (!ring) {
      issues.push({
        level: 'error',
        code: 'crack-orphan',
        message: `裂缝 ${crack.code} 关联的环片已缺失，迁移后找不到所属环片`,
        refKey: crack.ringId
      })
    } else if (snapshotSectionIds.has(ring.sectionId)) {
      const assignment = order.assignments.find((item) => item.ringId === ring.id)
      if (!assignment?.confirmed || !assignment.targetKey) {
        issues.push({
          level: 'error',
          code: 'crack-orphan',
          message: `裂缝 ${crack.code} 所属第 ${ring.ringNo} 环去向未确认，裂缝与复测记录无法安全迁移`,
          refKey: ring.id
        })
      }
    }
  })
  const crackById = new Map(scope.cracks.map((crack) => [crack.id, crack]))
  scope.surveys.forEach((survey) => {
    const crack = crackById.get(survey.crackId)
    if (!crack) {
      issues.push({
        level: 'warning',
        code: 'survey-orphan',
        message: `测次 ${survey.seq}（${survey.date}）关联裂缝已缺失，提交不会改动该测次`,
        refKey: survey.id
      })
    }
  })

  return dedupeIssues(issues)
}

function dedupeIssues(issues: RealignIssue[]): RealignIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.refKey ?? ''}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function targetLabel(target: RealignTarget): string {
  return `${target.line} ${target.startMileage}～${target.endMileage}`
}

export function hasBlockingIssue(issues: RealignIssue[]): boolean {
  return issues.some((issue) => issue.level === 'error')
}

/* ============================ 执行单元展开 ============================ */

/**
 * 把已确认方案展开为幂等执行单元：
 * 1. section-upsert：更新/新建目标区间；
 * 2. ring-update：环片改归属（同时带动裂缝 sectionId 冗余列在执行器内同步）；
 * 3. section-delete：合并中被吸收、且不再有环片指向的旧区间最后删除。
 */
export function expandUnits(
  order: Pick<RealignOrder, 'targets' | 'assignments'>,
  scope: RealignScope
): RealignUnit[] {
  const aliveTargets = order.targets.filter((target) => !target.removed)
  const targetByKey = new Map(aliveTargets.map((target) => [target.key, target]))
  const units: RealignUnit[] = []

  aliveTargets.forEach((target) => {
    units.push({
      kind: 'section-upsert',
      refId: target.key,
      payload: {
        sectionId: target.kind === 'existing' ? target.sectionId : newSectionId(target.key),
        isNew: target.kind !== 'existing',
        line: target.line,
        startMileage: target.startMileage,
        endMileage: target.endMileage,
        structureType: target.structureType
      }
    })
  })

  const sectionById = new Map(scope.sections.map((section) => [section.id, section]))
  const targetSectionIdOf = (target: RealignTarget): string =>
    target.kind === 'existing' ? target.sectionId : newSectionId(target.key)

  order.assignments.forEach((assignment) => {
    const target = assignment.targetKey ? targetByKey.get(assignment.targetKey) : null
    const ring = scope.rings.find((item) => item.id === assignment.ringId)
    if (!target || !ring) return
    units.push({
      kind: 'ring-update',
      refId: ring.id,
      payload: {
        targetKey: target.key,
        sectionId: targetSectionIdOf(target),
        ringNo: assignment.newRingNo,
        mileage: assignment.newMileage,
        fromSectionId: ring.sectionId
      }
    })
  })

  // 被吸收（合并）的旧区间最后删除：环片已全部迁走，仅删区间行本身（不级联）
  const aliveExistingIds = new Set(
    aliveTargets.filter((target) => target.kind === 'existing').map((target) => target.sectionId)
  )
  const absorbedIds = new Set<string>()
  aliveTargets.forEach((target) => target.absorbedSectionIds.forEach((id) => absorbedIds.add(id)))
  absorbedIds.forEach((sectionId) => {
    if (sectionById.has(sectionId) && !aliveExistingIds.has(sectionId)) {
      units.push({ kind: 'section-delete', refId: sectionId })
    }
  })

  return units
}
