/**
 * 区间调整单状态（Pinia）
 * 维护调整单列表与当前打开单据，提供目标区间编辑、环片去向确认、
 * 提交前校验预览、断点续跑提交与快照回滚。
 *
 * 页面只读 store 派生数据，所有写库动作收敛到本 store 与 utils/sectionAdjust。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AdjustmentRow } from '@/utils/db'
import {
  applyAdjustment,
  createAdjustmentOrder,
  deleteAdjustment,
  rollbackAdjustment,
  validateOrder,
  type CreateAdjustmentInput
} from '@/utils/sectionAdjust'
import {
  ADJUSTMENT_STATUS_TEXT,
  type AdjustmentIssue,
  type AdjustmentOrder,
  type AdjustmentTargetSection,
  type RingAssignment
} from '@/types/adjustment'
import type { Section, StructureType } from '@/types/section'
import type { Ring } from '@/types/ring'
import type { Crack } from '@/types/crack'
import { useSectionStore } from '@/stores/sectionStore'
import { useCrackStore } from '@/stores/crackStore'
import { useSurveyStore } from '@/stores/surveyStore'

/** 环片去向确认行的预览模型 */
export interface AssignmentView {
  assignment: RingAssignment
  ring: Ring | null
  fromSection: Section | null
  target: AdjustmentTargetSection | null
  cracks: Crack[]
  /** 该环裂缝关联的复测测次总数（测次不迁移，仅展示受影响面） */
  surveyCount: number
  /** 该环相关的阻断/提示问题 */
  issues: AdjustmentIssue[]
}

export const useAdjustmentStore = defineStore('adjustment', () => {
  const table = useIdbTable<AdjustmentRow>((database) => database.adjustments, {
    sortByUpdatedAt: false
  })
  const sectionStore = useSectionStore()
  const crackStore = useCrackStore()
  const surveyStore = useSurveyStore()

  const currentId = ref<string | null>(null)

  const orders = computed<AdjustmentRow[]>(() =>
    [...table.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )

  const current = computed<AdjustmentRow | null>(
    () => orders.value.find((order) => order.id === currentId.value) ?? null
  )

  /** 可继续重试（写入失败 / 写入中断）的单据数 */
  const resumableCount = computed(
    () => orders.value.filter((order) => order.status === 'failed' || order.status === 'applying').length
  )

  function selectOrder(id: string | null): void {
    currentId.value = id
  }

  async function createDraft(input: CreateAdjustmentInput): Promise<AdjustmentRow> {
    const order = await createAdjustmentOrder(input)
    currentId.value = order.id
    return (await db.adjustments.get(order.id)) as AdjustmentRow
  }

  /** 不可变更新整单并落库（保留快照/进度等运行时字段） */
  async function mutate(orderId: string, producer: (draft: AdjustmentOrder) => void): Promise<void> {
    const order = await db.adjustments.get(orderId)
    if (!order) throw new Error('调整单不存在或已被删除')
    if (order.status === 'applied') throw new Error('调整已完成，不能再编辑去向')
    producer(order)
    order.updatedAt = Date.now()
    // 方案或去向变化后，历史问题与断点进度需要重新校验/重跑
    order.issues = []
    order.lastError = ''
    await db.adjustments.put(order)
  }

  /** 编辑目标区间（线路 / 起止里程 / 结构型式） */
  async function updateTarget(
    orderId: string,
    targetKey: string,
    patch: Partial<Pick<AdjustmentTargetSection, 'line' | 'startMileage' | 'endMileage' | 'structureType'>>
  ): Promise<void> {
    await mutate(orderId, (draft) => {
      const target = draft.targets.find((item) => item.key === targetKey)
      if (!target) return
      if (patch.line !== undefined) target.line = patch.line.trim()
      if (patch.structureType !== undefined) target.structureType = patch.structureType as StructureType
      if (patch.startMileage !== undefined) target.startMileage = Math.max(0, Math.round(patch.startMileage))
      if (patch.endMileage !== undefined) target.endMileage = Math.max(0, Math.round(patch.endMileage))
    })
  }

  /** 指定某环去向（改动后需要重新确认） */
  async function setRingTarget(orderId: string, ringId: string, targetKey: string): Promise<void> {
    await mutate(orderId, (draft) => {
      const assignment = draft.assignments.find((item) => item.ringId === ringId)
      if (!assignment) return
      if (assignment.targetKey === targetKey) return
      assignment.targetKey = targetKey
      assignment.confirmed = false
      assignment.crossBoundary = targetKey !== assignment.fromSectionId
      draft.crossBoundaryRingIds = draft.assignments.filter((item) => item.crossBoundary).map((item) => item.ringId)
      void refreshAffectedCrackIds(draft)
    })
  }

  async function refreshAffectedCrackIds(draft: AdjustmentOrder): Promise<void> {
    const ids = draft.crossBoundaryRingIds
    if (ids.length === 0) {
      draft.affectedCrackIds = []
      return
    }
    const cracks = await db.cracks.where('ringId').anyOf(ids).toArray()
    draft.affectedCrackIds = cracks.map((crack) => crack.id)
  }

  async function confirmRing(orderId: string, ringId: string, confirmed: boolean): Promise<void> {
    await mutate(orderId, (draft) => {
      const assignment = draft.assignments.find((item) => item.ringId === ringId)
      if (assignment) assignment.confirmed = confirmed
    })
  }

  /** 批量确认：跨界环 / 全部环 */
  async function confirmAll(orderId: string, scope: 'crossBoundary' | 'all', confirmed: boolean): Promise<void> {
    await mutate(orderId, (draft) => {
      draft.assignments.forEach((assignment) => {
        if (scope === 'crossBoundary' && !assignment.crossBoundary) return
        assignment.confirmed = confirmed
      })
    })
  }

  /* ------------------------------ 校验预览 ------------------------------ */

  function issuesOf(order: AdjustmentOrder): AdjustmentIssue[] {
    return validateOrder(order, {
      sections: sectionStore.sections,
      rings: sectionStore.rings,
      cracks: crackStore.cracks
    })
  }

  const blockingCount = (order: AdjustmentOrder): number => issuesOf(order).filter((item) => item.level === 'error').length

  /** 实时校验（不落库，用于界面预览）；返回全部问题 */
  function previewIssues(order: AdjustmentOrder): AdjustmentIssue[] {
    return issuesOf(order)
  }

  /* ------------------------------ 行级派生 ------------------------------ */

  function targetOf(order: AdjustmentOrder, key: string): AdjustmentTargetSection | null {
    return order.targets.find((item) => item.key === key) ?? null
  }

  function assignmentViews(order: AdjustmentOrder): AssignmentView[] {
    const issues = issuesOf(order)
    return order.assignments
      .slice()
      .sort((a, b) => {
        const ringA = sectionStore.ringById.get(a.ringId)
        const ringB = sectionStore.ringById.get(b.ringId)
        const mileageA = ringA?.mileage ?? 0
        const mileageB = ringB?.mileage ?? 0
        return mileageA - mileageB || (ringA?.ringNo ?? 0) - (ringB?.ringNo ?? 0)
      })
      .map((assignment) => {
        const ring = sectionStore.ringById.get(assignment.ringId) ?? null
        const cracks = ring
          ? crackStore.cracks.filter((crack) => crack.ringId === ring.id)
          : []
        const surveyCount = cracks.reduce(
          (sum, crack) => sum + surveyStore.surveys.filter((survey) => survey.crackId === crack.id).length,
          0
        )
        return {
          assignment,
          ring,
          fromSection: sectionStore.sectionById.get(assignment.fromSectionId) ?? null,
          target: targetOf(order, assignment.targetKey),
          cracks,
          surveyCount,
          issues: issues.filter((issue) => issue.refRingId === assignment.ringId)
        }
      })
  }

  function crossBoundaryViews(order: AdjustmentOrder): AssignmentView[] {
    return assignmentViews(order).filter((view) => view.assignment.crossBoundary)
  }

  /** 受影响测次总数（跨界环片上裂缝的全部复测记录） */
  function affectedSurveyCount(order: AdjustmentOrder): number {
    return crossBoundaryViews(order).reduce((sum, view) => sum + view.surveyCount, 0)
  }

  function statusText(status: AdjustmentOrder['status']): string {
    return ADJUSTMENT_STATUS_TEXT[status]
  }

  /* ------------------------------ 提交 / 回滚 ------------------------------ */

  /** 统一提交：内部逐环断点推进，失败后再次调用即从上次停止处继续 */
  async function apply(orderId: string): Promise<AdjustmentRow> {
    return (await applyAdjustment(orderId)) as AdjustmentRow
  }

  async function rollback(orderId: string): Promise<AdjustmentRow> {
    return (await rollbackAdjustment(orderId)) as AdjustmentRow
  }

  async function remove(orderId: string): Promise<void> {
    await deleteAdjustment(orderId)
    if (currentId.value === orderId) currentId.value = null
  }

  return {
    table,
    orders,
    current,
    currentId,
    resumableCount,
    selectOrder,
    createDraft,
    updateTarget,
    setRingTarget,
    confirmRing,
    confirmAll,
    previewIssues,
    blockingCount,
    assignmentViews,
    crossBoundaryViews,
    affectedSurveyCount,
    targetOf,
    statusText,
    apply,
    rollback,
    remove
  }
})
