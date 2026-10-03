/**
 * 区间调整单：线路复检后重划区间（相邻区间合并 / 在某里程点拆分）。
 * - 区间台账（Section）负责行政分段，环片档案（Ring）负责实体身份；
 * - 调整时环片、裂缝、复测记录的 id 一律不变，只迁移 sectionId 归属，
 *   保证裂缝与复测记录不会换错所属环片。
 */
import type { StructureType } from '@/types/section'
import type { Section } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'

/** 调整方式：合并相邻区间 / 按里程点拆分区间 */
export type AdjustmentKind = 'merge' | 'split'

/** 调整单状态 */
export type AdjustmentStatus =
  | 'draft' // 草稿：方案与去向确认中，尚未写入正式表
  | 'applying' // 写入中：已按环片逐条推进，中断后可从断点继续
  | 'applied' // 已完成：新分段已生效
  | 'failed' // 写入失败：调整单与已确认去向保留，可重试
  | 'rolled-back' // 已回滚：按提交前快照恢复原归属

/** 目标区间去向类型：沿用既有区间 / 新分段后新建区间 / 合并后保留区间 */
export type TargetSectionMode = 'keep' | 'create'

/** 调整后的目标区间方案 */
export interface AdjustmentTargetSection {
  /** 调整单内的稳定标识；keep 时等于真实区间 id，create 时为临时键（建单时即分配真实 id） */
  key: string
  mode: TargetSectionMode
  /** 真实区间 id：keep 为原区间 id，create 在创建调整单时即预分配 */
  sectionId: string
  line: string
  startMileage: number
  endMileage: number
  structureType: StructureType
  /** merge 保留区间 / split 原区间沿用时为 true，不允许删除 */
  survivor: boolean
  /** merge 时并入的来源区间 id 列表（仅展示） */
  sourceSectionIds: string[]
}

/** 单个环片的去向记录 */
export interface RingAssignment {
  ringId: string
  /** 原所属区间 id（建单时快照） */
  fromSectionId: string
  /** 目标区间 AdjustmentTargetSection.key */
  targetKey: string
  /** 里程是否跨越调整前原区间边界（拆分点/合并缝两侧） */
  crossBoundary: boolean
  /** 人工是否已确认该环去向；未确认的环不允许提交 */
  confirmed: boolean
}

/** 提交前快照中的一行（回滚用：环号里程都按原值回填） */
export interface AdjustmentSnapshotItem {
  section?: Section
  ring?: Ring
  crack?: Crack
}

/** 提交前快照：只回写被调整涉及的区间与环片、裂缝 */
export interface AdjustmentSnapshot {
  sections: Section[]
  rings: Ring[]
  cracks: Crack[]
  /** 拆分/合并后被撤销的区间 id（回滚时需恢复其快照行） */
  removedSectionIds: string[]
}

/** 校验问题级别：error 阻断提交，warning 仅提示 */
export type AdjustmentIssueLevel = 'error' | 'warning'

/** 校验问题编码：与需求中三类硬性拦截一一对应 */
export type AdjustmentIssueCode =
  | 'mileage-overlap' // 同一里程落入两个区间
  | 'ring-no-collision' // 同一新区间内环号碰撞
  | 'ring-out-of-range' // 环片里程不在目标区间范围内（迁移后找不到所属区间）
  | 'ring-unassigned' // 被撤销区间的环片没有去向
  | 'ring-unconfirmed' // 环片去向尚未确认
  | 'orphan-crack' // 数据迁移后裂缝找不到所属环片
  | 'target-invalid' // 目标区间起止里程非法
  | 'line-mismatch' // 合并且非同线路（提示性）
  | 'boundary-touch' // 拆分里程落在某环里程点上（提示性）

export interface AdjustmentIssue {
  level: AdjustmentIssueLevel
  code: AdjustmentIssueCode
  message: string
  /** 关联的环片 / 区间 / 裂缝 id，便于在预览表定位 */
  refRingId?: string
  refSectionKey?: string
  refCrackId?: string
}

/** 调整单持久化结构（写入 IndexedDB adjustments 表） */
export interface AdjustmentOrder {
  id: string
  kind: AdjustmentKind
  status: AdjustmentStatus
  title: string
  /** merge：参与合并的来源区间 id；split：被拆分区间 id */
  sourceSectionIds: string[]
  /** split 时的拆分里程点（m） */
  splitAtMileage: number | null
  targets: AdjustmentTargetSection[]
  assignments: RingAssignment[]
  snapshot: AdjustmentSnapshot | null
  /** 已写入完成的环片 id（断点续跑从这里之后继续） */
  appliedRingIds: string[]
  /** 各来源区间中跨界（涉及迁移）的环片 id，预览置顶 */
  crossBoundaryRingIds: string[]
  /** 受影响测次对应的裂缝 id（仅统计展示，测次本身不迁移不改动） */
  affectedCrackIds: string[]
  issues: AdjustmentIssue[]
  lastError: string
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

export const ADJUSTMENT_STATUS_TEXT: Record<AdjustmentStatus, string> = {
  draft: '草稿',
  applying: '写入中',
  applied: '已完成',
  failed: '写入失败',
  'rolled-back': '已回滚'
}

/** 状态 → Element Plus 标签语义色 */
export const ADJUSTMENT_STATUS_TAG: Record<AdjustmentStatus, 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  draft: 'info',
  applying: 'primary',
  applied: 'success',
  failed: 'danger',
  'rolled-back': 'warning'
}

export const EMPTY_ADJUSTMENT_SNAPSHOT: AdjustmentSnapshot = {
  sections: [],
  rings: [],
  cracks: [],
  removedSectionIds: []
}
