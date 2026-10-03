/**
 * 区间重划（线路复检后行政分段调整）
 *
 * 概念边界：
 * - Section 台账只负责「行政分段」（线路、起止里程、结构型式），是可合并/拆分/改里程的对象。
 * - Ring 是「环片实体身份」，主键 id 永不因重划而改变；重划只调整 ring.sectionId / ringNo / mileage。
 * - Crack 跟随环片实体（crack.ringId 不变），仅同步冗余列 crack.sectionId；Survey 只认 crackId，完全不动。
 *
 * 一次重划以「调整单 RealignOrder」落库：先在界面预览跨界环片、裂缝与受影响测次，
 * 逐环确认去向后统一提交；校验不通过（里程跨区间、环号碰撞、裂缝找不到所属环片）整单不写入；
 * 提交按环生成可重放的执行单元，失败保留调整单与已确认去向，重试从上次停止处继续。
 */

/** 调整单状态 */
export type RealignStatus = '草稿' | '提交失败' | '已提交'

/** 目标区间行类型：沿用既有区间 / 重划后新建的区间 */
export type RealignTargetKind = 'existing' | 'new'

/** 单个执行单元的种类 */
export type RealignUnitKind = 'section-upsert' | 'section-delete' | 'ring-update'

/** 目标区间：重划方案中的一段行政分段 */
export interface RealignTarget {
  /** 前端生成的临时行 id（existing 时等于 section.id） */
  key: string
  /** existing=沿用既有区间（可改里程/结构型式）；new=重划新增区间（拆分点产生） */
  kind: RealignTargetKind
  /** 既有区间 id，仅 kind=existing 时有值 */
  sectionId: string
  /** 沿用区间的新里程/型式；新增区间的初始值。线路不允许改（跨界改线不在重划范围） */
  line: string
  startMileage: number
  endMileage: number
  structureType: string
  /** 合并：被吸收进本区间的既有区间 id 列表（提交时这些区间删除） */
  absorbedSectionIds: string[]
  /** 界面行标记：新建后又在方案里删掉用 */
  removed?: boolean
}

/** 环片去向：每一个现有环片在新方案中的归属，必须逐环确认 */
export interface RingAssignment {
  ringId: string
  /** 去向目标 key；null=尚未确认 */
  targetKey: string | null
  /** 新环号；缺省沿用旧环号 */
  newRingNo: number
  /** 新里程；缺省沿用旧里程 */
  newMileage: number
  /** 人工是否已确认该行去向（系统建议不算确认） */
  confirmed: boolean
}

/** 提交时的最小执行单元（按环/按区间幂等，可从断点重放） */
export interface RealignUnit {
  kind: RealignUnitKind
  /** ring-update → ringId；section-* → 目标 key 或被删区间 id */
  refId: string
  payload?: Record<string, unknown>
}

/** 执行结果 */
export interface RealignUnitResult {
  kind: RealignUnitKind
  refId: string
  done: boolean
  error?: string
}

/** 调整单提交前的问题项 */
export interface RealignIssue {
  /** 阻塞级：存在任一 error 整单不写入；warning 仅提示 */
  level: 'error' | 'warning'
  code:
    | 'target-invalid-range'
    | 'mileage-overlap'
    | 'ring-no-collision'
    | 'ring-unassigned'
    | 'ring-out-of-range'
    | 'crack-orphan'
    | 'survey-orphan'
    | 'section-touch-crossline'
    | 'section-missing'
  message: string
  /** 关联的目标 key / 环片 id，便于界面定位 */
  refKey?: string
}

/** 调整单快照里保存的原区间/环片信息（提交时定格，供旧备份之外的回查与回填原归属） */
export interface RealignSnapshot {
  sections: Array<{
    id: string
    line: string
    startMileage: number
    endMileage: number
    structureType: string
    ringCount: number
  }>
  rings: Array<{
    id: string
    sectionId: string
    ringNo: number
    mileage: number
  }>
}

/** 区间重划调整单 */
export interface RealignOrder {
  id: string
  name: string
  /** 方案涉及的线路（重划不跨线；取首个被调整区间的线路） */
  line: string
  status: RealignStatus
  note: string
  targets: RealignTarget[]
  assignments: RingAssignment[]
  /** 创建调整单时定格的原台账/环片快照（原归属凭证） */
  snapshot: RealignSnapshot
  /** 提交时展开的执行单元（草稿态可为空数组） */
  units: RealignUnit[]
  /** 已完成单元的 kind:refId 集合（断点续作用） */
  completed: string[]
  /** 最近一次执行结果（失败原因定位） */
  lastResults: RealignUnitResult[]
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

/** 新建调整单的入参 */
export interface RealignOrderDraft {
  name: string
  line: string
  note: string
}

export const REALIGN_STATUSES: RealignStatus[] = ['草稿', '提交失败', '已提交']

/** 单元完成标记（同一单元只执行一次的幂等键） */
export function unitDoneKey(unit: RealignUnit): string {
  return `${unit.kind}:${unit.refId}`
}
