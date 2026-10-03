/**
 * 区间重划调整单状态（Pinia）
 * 维护调整单列表、当前编辑单（草稿/失败/已提交）、方案编辑动作与提交/重试。
 * 环片身份（ring.id）与裂缝（crack.ringId）不在此处改写，归属落库统一走执行器。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type RealignOrderRow } from '@/utils/db'
import type {
  RealignOrder,
  RealignOrderDraft,
  RealignTarget,
  RingAssignment
} from '@/types/realign'
import {
  buildInitialPlan,
  createSplitTarget,
  mergeTarget,
  refreshSuggestions,
  validatePlan,
  type RealignScope
} from '@/utils/realign'
import { applyRealignOrder, RealignApplyError, RealignBlockedError } from '@/utils/realignApply'

/** 从业务表实时读取重划所需的台账范围（提交时重新读，保证重试基于现状） */
export async function loadRealignScope(): Promise<RealignScope> {
  const [sections, rings, cracks, surveys] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray()
  ])
  return { sections, rings, cracks, surveys }
}

export const useRealignStore = defineStore('realign', () => {
  const orderTable = useIdbTable<RealignOrderRow>((database) => database.realignOrders, {
    sortByUpdatedAt: true
  })

  const orders = computed(() => orderTable.rows.value)
  const activeOrderId = ref<string | null>(null)
  /** 最近一次提交/重试错误（用于界面红条展示） */
  const lastError = ref<string | null>(null)
  const submitting = ref(false)

  const activeOrder = computed<RealignOrderRow | null>(
    () => orders.value.find((order) => order.id === activeOrderId.value) ?? null
  )

  function selectOrder(id: string | null): void {
    activeOrderId.value = id
    lastError.value = null
  }

  /** 以某条线路当前台账为基准创建草稿调整单 */
  async function createOrder(draft: RealignOrderDraft): Promise<RealignOrderRow> {
    const scope = await loadRealignScope()
    const lineSections = scope.sections.filter((section) => section.line === draft.line)
    if (lineSections.length === 0) {
      throw new Error(`线路「${draft.line}」下暂无区间，无法发起重划`)
    }
    const plan = buildInitialPlan(scope, draft.line)
    const now = Date.now()
    const row: RealignOrderRow = {
      id: `ro_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: draft.name.trim() || `${draft.line}重划-${new Date().toISOString().slice(0, 10)}`,
      line: draft.line,
      status: '草稿',
      note: draft.note.trim(),
      targets: plan.targets,
      assignments: plan.assignments,
      snapshot: plan.snapshot,
      units: [],
      completed: [],
      lastResults: [],
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      revision: 3
    }
    await orderTable.upsert(row)
    activeOrderId.value = row.id
    lastError.value = null
    scopeCache = scope
    return row
  }

  /** 落草稿：保留调整单与已确认去向（每次编辑都持久化，刷新/掉电不丢） */
  async function saveActive(mutator?: (order: RealignOrder) => void): Promise<void> {
    const current = activeOrder.value
    if (!current) return
    if (current.status === '已提交') return
    // 克隆方案体再改，避免直接变动 liveQuery 订阅返回的响应式行
    const draft: RealignOrder = {
      ...current,
      targets: current.targets.map((target) => ({ ...target, absorbedSectionIds: [...target.absorbedSectionIds] })),
      assignments: current.assignments.map((item) => ({ ...item })),
      snapshot: {
        sections: current.snapshot.sections.map((item) => ({ ...item })),
        rings: current.snapshot.rings.map((item) => ({ ...item }))
      },
      units: current.units.map((item) => ({ ...item, payload: item.payload ? { ...item.payload } : undefined })),
      completed: [...current.completed],
      lastResults: [...current.lastResults]
    }
    if (mutator) mutator(draft)
    const next: RealignOrderRow = { ...draft, updatedAt: Date.now() }
    await orderTable.upsert(next)
  }

  async function updateNote(note: string): Promise<void> {
    await saveActive((order) => {
      order.note = note
    })
  }

  async function updateName(name: string): Promise<void> {
    await saveActive((order) => {
      order.name = name
    })
  }

  /** 编辑目标区间（里程/结构型式等），编辑后刷新未确认行的建议去向 */
  async function updateTarget(key: string, patch: Partial<RealignTarget>): Promise<void> {
    await saveActive((order) => {
      order.targets = order.targets.map((target) =>
        target.key === key ? { ...target, ...patch } : target
      )
      const scope = cachedScope()
      if (scope) order.assignments = refreshSuggestions(order.targets, order.assignments, scope.rings)
    })
  }

  /** 在某个里程点拆开：新增目标区间（里程/型式由界面再填） */
  async function addSplitTarget(structureType?: string): Promise<string | null> {
    const current = activeOrder.value
    if (!current) return null
    const fallback = current.targets.find((target) => !target.removed)?.structureType ?? '盾构'
    const target = createSplitTarget(current.line, structureType ?? fallback)
    // 初始给一个不与任何目标重叠的占位里程（取已用里程最大值 +50），避免一新增就是非法区间
    const usedMax = Math.max(0, ...current.targets.map((t) => t.endMileage))
    target.startMileage = usedMax + 50
    target.endMileage = usedMax + 150
    await saveActive((order) => {
      order.targets = [...order.targets, target]
      const live = cachedScope()
      if (live) order.assignments = refreshSuggestions(order.targets, order.assignments, live.rings)
    })
    return target.key
  }

  /** 删除新建目标（既有区间不允许从方案中删除，只能被合并吸收） */
  async function removeTarget(key: string): Promise<void> {
    await saveActive((order) => {
      const target = order.targets.find((item) => item.key === key)
      if (!target || target.kind !== 'new') return
      order.targets = order.targets.filter((item) => item.key !== key)
      order.assignments = order.assignments.map((item) =>
        item.targetKey === key ? { ...item, targetKey: null, confirmed: false } : item
      )
    })
  }

  /** 合并：把 source 吸收进 dest，跨界环片去向改挂并要求重新确认 */
  async function mergeTargets(sourceKey: string, destKey: string): Promise<void> {
    await saveActive((order) => {
      const merged = mergeTarget(order.targets, order.assignments, sourceKey, destKey)
      order.targets = merged.targets
      order.assignments = merged.assignments
    })
  }

  async function updateAssignment(ringId: string, patch: Partial<RingAssignment>): Promise<void> {
    await saveActive((order) => {
      order.assignments = order.assignments.map((item) =>
        item.ringId === ringId ? { ...item, ...patch } : item
      )
    })
  }

  /** 人工确认/取消确认某环去向 */
  async function confirmAssignment(ringId: string, confirmed: boolean): Promise<void> {
    await updateAssignment(ringId, { confirmed })
  }

  /** 批量确认（仅把当前无阻塞问题的行置为已确认，避免误确认碰撞行） */
  async function confirmAllValid(): Promise<number> {
    const scope = await loadRealignScope()
    const current = activeOrder.value
    if (!current) return 0
    const issues = validatePlan({ ...current }, scope)
    const blockedRings = new Set(
      issues
        .filter((issue) => issue.level === 'error' && issue.code !== 'ring-unassigned')
        .map((issue) => issue.refKey ?? '')
    )
    let count = 0
    await saveActive((order) => {
      order.assignments = order.assignments.map((item) => {
        const targetExists = !!item.targetKey && order.targets.some((t) => t.key === item.targetKey && !t.removed)
        if (targetExists && !blockedRings.has(item.ringId) && !item.confirmed) {
          count += 1
          return { ...item, confirmed: true }
        }
        return item
      })
    })
    return count
  }

  async function unconfirmAll(): Promise<void> {
    await saveActive((order) => {
      order.assignments = order.assignments.map((item) => ({ ...item, confirmed: false }))
    })
  }

  /** 实时校验当前草稿（不写入），供界面预览阻塞问题与受影响对象 */
  async function previewIssues() {
    const current = activeOrder.value
    if (!current) return []
    return validatePlan({ ...current }, await loadRealignScope())
  }

  async function removeOrder(id: string): Promise<void> {
    await orderTable.remove(id)
    if (activeOrderId.value === id) activeOrderId.value = null
  }

  /** 统一提交：先校验，通过后逐单元写入；失败保留单据并从断点可续 */
  async function submitActive(): Promise<RealignOrder | null> {
    const current = activeOrder.value
    if (!current || current.status === '已提交') return null
    submitting.value = true
    lastError.value = null
    try {
      const scope = await loadRealignScope()
      const outcome = await applyRealignOrder({ ...current }, scope, (order, nextScope) =>
        validatePlan(order, nextScope).filter((issue) => issue.level === 'error')
      )
      activeOrderId.value = outcome.order.id
      return outcome.order
    } catch (error) {
      if (error instanceof RealignBlockedError) {
        lastError.value = `存在阻塞冲突，本次调整未写入：${error.message}`
      } else if (error instanceof RealignApplyError) {
        lastError.value = `写入中断，已保留调整单与已确认去向，可从断点重试：${error.message}`
      } else {
        lastError.value = error instanceof Error ? error.message : '提交失败'
      }
      return null
    } finally {
      submitting.value = false
    }
  }

  /** 重试：与提交同一入口，执行器按 order.completed 跳过已完成单元 */
  async function retryActive(): Promise<RealignOrder | null> {
    return submitActive()
  }

  /**
   * 编辑期间复用的台账快照：store 不直接依赖业务 store，
   * 提供一个惰性缓存供方案编辑动作刷新建议去向；提交时一律重新 loadRealignScope()。
   */
  let scopeCache: RealignScope | null = null
  function cachedScope(): RealignScope | null {
    return scopeCache
  }
  async function refreshScopeCache(): Promise<RealignScope> {
    scopeCache = await loadRealignScope()
    return scopeCache
  }

  const draftCount = computed(() => orders.value.filter((order) => order.status === '草稿').length)
  const failedCount = computed(() => orders.value.filter((order) => order.status === '提交失败').length)
  const submittedCount = computed(() => orders.value.filter((order) => order.status === '已提交').length)

  return {
    orderTable,
    orders,
    activeOrderId,
    activeOrder,
    lastError,
    submitting,
    draftCount,
    failedCount,
    submittedCount,
    selectOrder,
    createOrder,
    saveActive,
    updateName,
    updateNote,
    updateTarget,
    addSplitTarget,
    removeTarget,
    mergeTargets,
    updateAssignment,
    confirmAssignment,
    confirmAllValid,
    unconfirmAll,
    previewIssues,
    removeOrder,
    submitActive,
    retryActive,
    refreshScopeCache
  }
})
