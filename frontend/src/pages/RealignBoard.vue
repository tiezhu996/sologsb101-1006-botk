<script setup lang="ts">
/**
 * /realign 区间重划与归属调整
 * 线路复检后重划行政分段：相邻区间合并、在里程点拆开。
 * 先预览跨界环片、裂缝与受影响测次，逐环确认去向后统一提交；
 * 里程跨区间/环号碰撞/裂缝找不到所属环片时整单不写入；写入失败保留单据断点续提。
 */
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheckFilled,
  Delete,
  DocumentAdd,
  Promotion,
  RefreshRight,
  ScaleToOriginal,
  Switch,
  VideoPause,
  WarningFilled
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useRealignStore } from '@/stores/realignStore'
import { useSectionStore } from '@/stores/sectionStore'
import { db } from '@/utils/db'
import { buildViews, validatePlan, type RealignScope } from '@/utils/realign'
import { STRUCTURE_TYPES, formatMileage } from '@/types/section'
import type { RealignIssue, RealignOrder, RealignTarget, RingAssignment } from '@/types/realign'
import { unitDoneKey } from '@/types/realign'

const realignStore = useRealignStore()
const sectionStore = useSectionStore()
const { activeOrder } = storeToRefs(realignStore)

/* ------------------------------ 新建调整单 ------------------------------ */

const createVisible = ref(false)
const createForm = ref({ name: '', line: '', note: '' })

const createLineOptions = computed(() =>
  Array.from(new Set(sectionStore.sections.map((section) => section.line))).map((line) => ({ label: line, value: line }))
)

function openCreate(): void {
  createForm.value = {
    name: '',
    line: createLineOptions.value[0]?.value ?? '',
    note: ''
  }
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!createForm.value.line) {
    ElMessage.warning('请选择需要重划的线路')
    return
  }
  try {
    const order = await realignStore.createOrder(createForm.value)
    await realignStore.refreshScopeCache()
    ElMessage.success(`调整单「${order.name}」已创建，请在右侧逐环确认去向`)
    createVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建调整单失败')
  }
}

/* ------------------------------ 实时预览 ------------------------------ */

/** 界面预览用台账范围：随各表 liveQuery 行重算，保证展示的是最新台账 */
const scope = computed<RealignScope>(() => ({
  sections: sectionStore.sections,
  rings: sectionStore.rings,
  cracks: [],
  surveys: []
}))

const fullScopeLoaded = ref<RealignScope | null>(null)

async function reloadFullScope(): Promise<void> {
  const [sections, rings, cracks, surveys] = await Promise.all([
    db.sections.toArray(),
    db.rings.toArray(),
    db.cracks.toArray(),
    db.surveys.toArray()
  ])
  fullScopeLoaded.value = { sections, rings, cracks, surveys }
}

watch(
  () => activeOrder.value?.id,
  (id) => {
    if (id) void reloadFullScope()
  },
  { immediate: true }
)

const previewScope = computed<RealignScope>(() =>
  fullScopeLoaded.value
    ? {
        sections: sectionStore.sections.length ? sectionStore.sections : fullScopeLoaded.value.sections,
        rings: sectionStore.rings.length ? sectionStore.rings : fullScopeLoaded.value.rings,
        cracks: fullScopeLoaded.value.cracks,
        surveys: fullScopeLoaded.value.surveys
      }
    : scope.value
)

const views = computed(() => (activeOrder.value ? buildViews(activeOrder.value, previewScope.value) : null))

const crossBoundaryRings = computed(() => views.value?.rings.filter((item) => item.crossBoundary) ?? [])

const affectedCrackCount = computed(
  () => new Set(crossBoundaryRings.value.flatMap((item) => item.cracks.map((crack) => crack.id))).size
)

const affectedSurveyCount = computed(() =>
  crossBoundaryRings.value.reduce((sum, item) => sum + item.surveyCount, 0)
)

const confirmedCount = computed(() => activeOrder.value?.assignments.filter((item) => item.confirmed).length ?? 0)

/* ------------------------------ 校验问题 ------------------------------ */

const issues = computed<RealignIssue[]>(() => {
  if (!activeOrder.value) return []
  // 复用引擎校验（与提交时同一函数，避免「预览能过、提交不过」）
  return validatePlan(activeOrder.value, previewScope.value)
})

const blockingIssues = computed(() => issues.value.filter((issue) => issue.level === 'error'))
const warningIssues = computed(() => issues.value.filter((issue) => issue.level === 'warning'))
const canSubmit = computed(
  () =>
    !!activeOrder.value &&
    activeOrder.value.status !== '已提交' &&
    activeOrder.value.assignments.length > 0 &&
    confirmedCount.value === activeOrder.value.assignments.length &&
    blockingIssues.value.length === 0
)

/* ------------------------------ 目标区间编辑 ------------------------------ */

function targetStatusType(target: RealignTarget): 'success' | 'warning' | 'primary' {
  return target.kind === 'new' ? 'success' : target.absorbedSectionIds.length > 0 ? 'warning' : 'primary'
}

async function onTargetEdit(target: RealignTarget, patch: Partial<RealignTarget>): Promise<void> {
  await realignStore.updateTarget(target.key, patch)
}

async function addSplit(): Promise<void> {
  const key = await realignStore.addSplitTarget()
  if (key) ElMessage.info('已新增拆分区间，请设置起止里程，并把跨界环片改挂到新区间')
}

async function removeTarget(target: RealignTarget): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除拆分区间「${formatMileage(target.startMileage)}～${formatMileage(target.endMileage)}」后，其下环片去向将清空，确认删除？`,
    '删除目标区间',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await realignStore.removeTarget(target.key)
}

const mergeVisible = ref(false)
const mergeSourceKey = ref('')
const mergeDestKey = ref('')

function openMerge(sourceKey: string): void {
  mergeSourceKey.value = sourceKey
  mergeDestKey.value = ''
  mergeVisible.value = true
}

const mergeDestOptions = computed(() =>
  (views.value?.targets ?? [])
    .filter((item) => item.target.key !== mergeSourceKey.value)
    .map((item) => ({
      label: `${item.target.kind === 'new' ? '新·' : ''}${formatMileage(item.target.startMileage)}～${formatMileage(item.target.endMileage)}`,
      value: item.target.key
    }))
)

async function confirmMerge(): Promise<void> {
  if (!mergeDestKey.value) {
    ElMessage.warning('请选择并入的目标区间')
    return
  }
  await realignStore.mergeTargets(mergeSourceKey.value, mergeDestKey.value)
  mergeVisible.value = false
  ElMessage.success('已合并，改挂环片需重新确认去向')
}

/* ------------------------------ 环片去向编辑 ------------------------------ */

const targetSelectOptions = computed(() =>
  (views.value?.targets ?? []).map((item) => ({
    label: `${item.target.kind === 'new' ? '新·' : ''}${item.target.line} ${formatMileage(item.target.startMileage)}～${formatMileage(item.target.endMileage)}`,
    value: item.target.key
  }))
)

async function changeTarget(item: { assignment: RingAssignment }, targetKey: string | unknown): Promise<void> {
  await realignStore.updateAssignment(item.assignment.ringId, { targetKey: String(targetKey), confirmed: false })
}

async function changeRingNo(item: { assignment: RingAssignment }, value: number | undefined): Promise<void> {
  await realignStore.updateAssignment(item.assignment.ringId, { newRingNo: Number(value ?? 0), confirmed: false })
}

async function changeMileage(item: { assignment: RingAssignment }, value: number | undefined): Promise<void> {
  await realignStore.updateAssignment(item.assignment.ringId, { newMileage: Number(value ?? 0), confirmed: false })
}

async function toggleConfirm(item: { assignment: RingAssignment }, checked: boolean | string | number): Promise<void> {
  await realignStore.confirmAssignment(item.assignment.ringId, checked === true)
}

async function confirmAll(): Promise<void> {
  const n = await realignStore.confirmAllValid()
  ElMessage.success(n > 0 ? `已确认 ${n} 个无冲突环片的去向` : '没有可确认的无冲突环片')
}

async function unconfirmAll(): Promise<void> {
  await realignStore.unconfirmAll()
}

/* ------------------------------ 提交与断点续提 ------------------------------ */

async function submit(): Promise<void> {
  const order = activeOrder.value
  if (!order) return
  const confirmed = await ElMessageBox.confirm(
    `将按已确认的 ${confirmedCount.value} 个环片去向统一写入：更新区间里程/环号、随环同步裂缝归属（复测记录不动）。确认提交？`,
    '统一提交确认',
    { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  const result = await realignStore.submitActive()
  await reloadFullScope()
  await realignStore.refreshScopeCache()
  if (result && result.status === '已提交') {
    ElMessage.success('区间重划已完成，台账/环号里程/速率预警已按新分段展示')
  } else {
    ElMessage.error(realignStore.lastError ?? '提交未完成')
  }
}

async function retry(): Promise<void> {
  const result = await realignStore.retryActive()
  await reloadFullScope()
  await realignStore.refreshScopeCache()
  if (result && result.status === '已提交') {
    ElMessage.success('断点续提完成，区间重划已生效')
  } else {
    ElMessage.error(realignStore.lastError ?? '重试未完成')
  }
}

async function removeOrder(order: RealignOrder): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `删除调整单「${order.name}」？${order.status === '已提交' ? '（已生效的台账变更不会回滚，仅删除单据记录）' : '（未提交的方案将丢失）'}`,
    '删除调整单',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await realignStore.removeOrder(order.id)
  ElMessage.success('调整单已删除')
}

const progressPercent = computed(() => {
  const order = activeOrder.value
  if (!order || order.units.length === 0) return order?.status === '已提交' ? 100 : 0
  const done = order.completed.length
  return Math.round((done / order.units.length) * 100)
})

function unitDone(unitKey: string): boolean {
  return activeOrder.value?.completed.includes(unitKey) ?? false
}

function statusTagType(status: RealignOrder['status']): 'info' | 'danger' | 'success' {
  return status === '已提交' ? 'success' : status === '提交失败' ? 'danger' : 'info'
}

function ringRowKey(row: { assignment: RingAssignment }): string {
  return row.assignment.ringId
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">区间重划与归属调整</h2>
        <p class="page-head__desc">
          线路复检后重划行政分段：相邻区间可合并、可在里程点拆开。先预览跨界环片、裂缝与受影响测次，逐环确认去向后统一提交。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button type="primary" :icon="DocumentAdd" @click="openCreate">新建调整单</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="调整单总数" :value="realignStore.orders.length" suffix="张" icon="Files" tone="primary" />
      <StatBadge label="草稿" :value="realignStore.draftCount" suffix="张" icon="EditPen" tone="info" />
      <StatBadge label="提交失败（可续提）" :value="realignStore.failedCount" suffix="张" icon="WarningFilled" tone="danger" />
      <StatBadge label="已提交" :value="realignStore.submittedCount" suffix="张" icon="CircleCheckFilled" tone="success" />
    </div>

    <div class="grid-realign">
      <!-- 左：调整单列表 -->
      <div class="panel">
        <h3 class="panel-title">调整单</h3>
        <EmptyPanel
          v-if="realignStore.orders.length === 0"
          title="还没有调整单"
          description="线路复检后，针对一条线路发起重划：合并相邻区间或在某个里程点拆开。"
          action-text="新建调整单"
          compact
          @action="openCreate"
        />
        <div
          v-for="order in realignStore.orders"
          :key="order.id"
          class="order-card"
          :class="{ 'is-active': order.id === realignStore.activeOrderId }"
          @click="realignStore.selectOrder(order.id)"
        >
          <div class="order-card__head">
            <span class="order-card__title">{{ order.name }}</span>
            <el-tag size="small" :type="statusTagType(order.status)">{{ order.status }}</el-tag>
          </div>
          <div class="order-card__meta">
            <span>{{ order.line }}</span>
            <span>· {{ order.assignments.length }} 环</span>
            <span>· 已确认 {{ order.assignments.filter((a) => a.confirmed).length }}</span>
          </div>
          <div v-if="order.status === '提交失败'" class="order-card__warn">
            <el-icon><WarningFilled /></el-icon> 写入中断于断点，可重试续提
          </div>
          <div class="order-card__actions" @click.stop>
            <el-button size="small" text type="danger" @click="removeOrder(order)">
              <el-icon><Delete /></el-icon> 删除
            </el-button>
          </div>
        </div>
      </div>

      <!-- 右：方案编辑与预览 -->
      <div class="panel realign-detail">
        <EmptyPanel
          v-if="!activeOrder"
          title="选择或新建一张调整单"
          description="调整单会定格当前台账快照；编辑过程中随时保存，提交失败也保留已确认去向。"
          action-text="新建调整单"
          compact
          @action="openCreate"
        />

        <template v-else>
          <div class="detail-head">
            <div>
              <h3 class="panel-title" style="margin-bottom: 4px">
                {{ activeOrder.name }}
                <el-tag size="small" :type="statusTagType(activeOrder.status)" style="margin-left: 8px">
                  {{ activeOrder.status }}
                </el-tag>
              </h3>
              <span class="muted">{{ activeOrder.line }} · 快照环片 {{ activeOrder.snapshot.rings.length }} 个</span>
            </div>
            <div class="detail-head__actions">
              <el-button :icon="ScaleToOriginal" @click="addSplit" :disabled="activeOrder.status === '已提交'">
                里程点拆分
              </el-button>
              <el-button
                type="success"
                plain
                :icon="CircleCheckFilled"
                :disabled="activeOrder.status === '已提交'"
                @click="confirmAll"
              >
                一键确认无冲突环
              </el-button>
              <el-button text :disabled="activeOrder.status === '已提交'" @click="unconfirmAll">全部取消确认</el-button>
            </div>
          </div>

          <!-- 受影响概览 -->
          <el-alert
            :closable="false"
            class="overview-alert"
            :type="crossBoundaryRings.length > 0 ? 'warning' : 'info'"
            show-icon
          >
            <template #title>
              跨界环片 <strong>{{ crossBoundaryRings.length }}</strong> 个 · 受影响裂缝
              <strong>{{ affectedCrackCount }}</strong> 条 · 受影响测次
              <strong>{{ affectedSurveyCount }}</strong> 次 · 已确认去向
              <strong>{{ confirmedCount }}/{{ activeOrder.assignments.length }}</strong>
            </template>
          </el-alert>

          <!-- 阻塞问题 -->
          <el-alert
            v-if="blockingIssues.length > 0"
            class="issue-alert"
            type="error"
            :closable="false"
            show-icon
            title="存在阻塞冲突，本次调整不会写入（现台账继续可用）"
          >
            <ul class="issue-list">
              <li v-for="(issue, i) in blockingIssues.slice(0, 8)" :key="`e-${i}`">{{ issue.message }}</li>
              <li v-if="blockingIssues.length > 8">…等 {{ blockingIssues.length }} 项</li>
            </ul>
          </el-alert>
          <el-alert
            v-if="warningIssues.length > 0"
            class="issue-alert"
            type="warning"
            :closable="false"
            show-icon
            title="提示信息（不阻塞提交）"
          >
            <ul class="issue-list">
              <li v-for="(issue, i) in warningIssues.slice(0, 4)" :key="`w-${i}`">{{ issue.message }}</li>
            </ul>
          </el-alert>

          <!-- 失败断点 -->
          <el-alert
            v-if="activeOrder.status === '提交失败'"
            class="issue-alert"
            type="error"
            :closable="false"
            show-icon
          >
            <template #title>
              上次写入已中断，调整单与已确认去向均保留：完成 {{ activeOrder.completed.length }}/{{ activeOrder.units.length }}
              步，可从断点继续。
            </template>
          </el-alert>

          <!-- 目标区间 -->
          <div class="section-block">
            <div class="section-block__head">
              <h4>重划后区间（{{ views?.targets.length ?? 0 }}）</h4>
              <span class="muted">改里程=拆分边界；合并请点「并入」；新建区间可删除</span>
            </div>
            <div
              v-for="item in views?.targets ?? []"
              :key="item.target.key"
              class="target-card"
              :class="{ 'is-new': item.target.kind === 'new' }"
            >
              <div class="target-card__row">
                <el-tag size="small" :type="targetStatusType(item.target)">{{ item.target.kind === 'new' ? '拆分新增' : '既有' }}</el-tag>
                <el-input-number
                  :model-value="item.target.startMileage"
                  :min="0"
                  :step="10"
                  :controls="false"
                  size="small"
                  style="width: 120px"
                  :disabled="activeOrder.status === '已提交'"
                  @change="(v: number) => onTargetEdit(item.target, { startMileage: Number(v ?? 0) })"
                />
                <span class="muted">～</span>
                <el-input-number
                  :model-value="item.target.endMileage"
                  :min="0"
                  :step="10"
                  :controls="false"
                  size="small"
                  style="width: 120px"
                  :disabled="activeOrder.status === '已提交'"
                  @change="(v: number) => onTargetEdit(item.target, { endMileage: Number(v ?? 0) })"
                />
                <el-select
                  :model-value="item.target.structureType"
                  size="small"
                  style="width: 110px"
                  :disabled="activeOrder.status === '已提交'"
                  @change="(v: string) => onTargetEdit(item.target, { structureType: v })"
                >
                  <el-option v-for="t in STRUCTURE_TYPES" :key="t" :label="t" :value="t" />
                </el-select>
                <span class="muted">{{ formatMileage(item.target.startMileage) }}～{{ formatMileage(item.target.endMileage) }}</span>
                <span class="target-card__count">{{ item.assignedRings.length }} 环</span>
                <div class="target-card__actions">
                  <el-button
                    size="small"
                    text
                    type="warning"
                    :icon="Switch"
                    :disabled="activeOrder.status === '已提交' || (views?.targets.length ?? 0) < 2"
                    @click="openMerge(item.target.key)"
                  >
                    并入其它区间
                  </el-button>
                  <el-button
                    v-if="item.target.kind === 'new'"
                    size="small"
                    text
                    type="danger"
                    :icon="Delete"
                    :disabled="activeOrder.status === '已提交'"
                    @click="removeTarget(item.target)"
                  >
                    删除
                  </el-button>
                </div>
              </div>
              <div v-if="item.absorbedSections.length > 0" class="target-card__absorbed">
                合并吸收：
                <el-tag
                  v-for="s in item.absorbedSections"
                  :key="s.id"
                  size="small"
                  type="warning"
                  effect="plain"
                  style="margin-right: 6px"
                >
                  {{ s.line }} {{ formatMileage(s.startMileage) }}～{{ formatMileage(s.endMileage) }}
                </el-tag>
                提交后删除该区间行（环片随迁，裂缝/复测不删）
              </div>
            </div>
          </div>

          <!-- 环片去向 -->
          <div class="section-block">
            <div class="section-block__head">
              <h4>环片去向与跨界预览（{{ views?.rings.length ?? 0 }}）</h4>
              <span class="muted">环片实体身份不变，裂缝随环片迁移、仅同步区间归属，复测记录不动</span>
            </div>
            <el-table :data="views?.rings ?? []" :row-key="ringRowKey" border stripe size="small">
              <el-table-column label="原区间" min-width="150">
                <template #default="{ row }">
                  {{ row.fromSection ? `${row.fromSection.line} ${formatMileage(row.fromSection.startMileage)}` : '—' }}
                </template>
              </el-table-column>
              <el-table-column label="环号 → 新环号" width="170">
                <template #default="{ row }">
                  <span :class="{ 'muted': !row.crossBoundary }">第 {{ row.ring.ringNo }} 环</span>
                  <el-input-number
                    :model-value="row.assignment.newRingNo"
                    :min="1"
                    :controls="false"
                    size="small"
                    style="width: 86px; margin-left: 8px"
                    :disabled="activeOrder.status === '已提交'"
                    @change="(v: number) => changeRingNo(row, v)"
                  />
                </template>
              </el-table-column>
              <el-table-column label="新里程(m)" width="130">
                <template #default="{ row }">
                  <el-input-number
                    :model-value="row.assignment.newMileage"
                    :min="0"
                    :controls="false"
                    size="small"
                    style="width: 104px"
                    :disabled="activeOrder.status === '已提交'"
                    @change="(v: number) => changeMileage(row, v)"
                  />
                </template>
              </el-table-column>
              <el-table-column label="去向区间" min-width="220">
                <template #default="{ row }">
                  <el-select
                    :model-value="row.assignment.targetKey"
                    size="small"
                    style="width: 100%"
                    :disabled="activeOrder.status === '已提交'"
                    @change="(v: string) => changeTarget(row, v)"
                  >
                    <el-option v-for="opt in targetSelectOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="裂缝/测次" width="110">
                <template #default="{ row }">
                  <el-tooltip
                    :disabled="row.cracks.length === 0"
                    placement="top"
                    effect="light"
                  >
                    <template #content>
                      <div v-for="crack in row.cracks" :key="crack.id" class="crack-tip">
                        {{ crack.code }} · {{ crack.position }} · 测次随裂缝保留
                      </div>
                    </template>
                    <span :style="{ color: row.crossBoundary ? '#d68910' : undefined }">
                      {{ row.cracks.length }} 条 / {{ row.surveyCount }} 次
                    </span>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="校验" width="120">
                <template #default="{ row }">
                  <el-tag v-if="!row.assignment.targetKey" size="small" type="danger">未指派</el-tag>
                  <el-tag v-else-if="!row.mileageFits" size="small" type="danger">里程越界</el-tag>
                  <el-tag v-else-if="row.collision" size="small" type="danger">环号碰撞</el-tag>
                  <el-tag v-else-if="row.crossBoundary" size="small" type="warning">跨界</el-tag>
                  <el-tag v-else size="small" type="success">正常</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="确认去向" width="90" fixed="right">
                <template #default="{ row }">
                  <el-checkbox
                    :model-value="row.assignment.confirmed"
                    :disabled="activeOrder.status === '已提交' || !row.assignment.targetKey || !row.mileageFits || row.collision"
                    @change="(v: boolean | string | number) => toggleConfirm(row, v)"
                  />
                </template>
              </el-table-column>
            </el-table>
          </div>

          <!-- 断点进度（失败/已提交时展示） -->
          <div v-if="activeOrder.units.length > 0 || activeOrder.status === '已提交'" class="section-block">
            <div class="section-block__head">
              <h4>写入进度（断点续提）</h4>
            </div>
            <el-progress :percentage="progressPercent" :status="activeOrder.status === '已提交' ? 'success' : undefined" />
            <div class="unit-list">
              <div
                v-for="unit in activeOrder.units"
                :key="unitDoneKey(unit)"
                class="unit-item"
                :class="{ 'is-done': unitDone(unitDoneKey(unit)) }"
              >
                <el-icon><CircleCheckFilled v-if="unitDone(unitDoneKey(unit))" /><VideoPause v-else /></el-icon>
                <span>{{ unit.kind === 'ring-update' ? `环片迁移 ${unit.refId}` : unit.kind === 'section-delete' ? `删除合并区间 ${unit.refId}` : `区间写入 ${unit.refId}` }}</span>
              </div>
            </div>
          </div>

          <!-- 提交栏 -->
          <div class="submit-bar">
            <div class="submit-bar__tip">
              <el-icon v-if="canSubmit" color="#1e8449"><CircleCheckFilled /></el-icon>
              <el-icon v-else color="#d68910"><WarningFilled /></el-icon>
              <span v-if="activeOrder.status === '已提交'">该调整单已生效；区间、环号里程与速率预警已按新分段展示。</span>
              <span v-else-if="blockingIssues.length > 0">存在 {{ blockingIssues.length }} 项阻塞冲突，整单不会写入。</span>
              <span v-else-if="confirmedCount < activeOrder.assignments.length">
                还有 {{ activeOrder.assignments.length - confirmedCount }} 个环片去向未确认。
              </span>
              <span v-else>去向已全部确认且无冲突，可以统一提交。</span>
            </div>
            <div>
              <el-button
                v-if="activeOrder.status === '提交失败'"
                type="warning"
                :icon="RefreshRight"
                :loading="realignStore.submitting"
                @click="retry"
              >
                从断点重试
              </el-button>
              <el-button
                v-else
                type="primary"
                :icon="Promotion"
                :disabled="!canSubmit"
                :loading="realignStore.submitting"
                @click="submit"
              >
                统一提交
              </el-button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 新建调整单 -->
    <el-dialog v-model="createVisible" title="新建区间重划调整单" width="480px">
      <el-form label-width="92px">
        <el-form-item label="调整单名称">
          <el-input v-model="createForm.name" placeholder="如 1号线 K12 段复检重划" />
        </el-form-item>
        <el-form-item label="线路" required>
          <el-select v-model="createForm.line" style="width: 100%" placeholder="选择线路">
            <el-option v-for="opt in createLineOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.note" type="textarea" :rows="3" placeholder="复检依据、拆分/合并原因" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建并定格快照</el-button>
      </template>
    </el-dialog>

    <!-- 合并对话框 -->
    <el-dialog v-model="mergeVisible" title="合并区间（吸收相邻分段）" width="440px">
      <p class="muted" style="margin: 0 0 12px">
        被并入区间将从方案移除并在提交时删除区间行；其环片改挂目标区间后需重新确认去向，裂缝与复测记录随环片保留。
      </p>
      <el-select v-model="mergeDestKey" style="width: 100%" placeholder="选择并入的目标区间">
        <el-option v-for="opt in mergeDestOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="warning" @click="confirmMerge">确认合并</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.grid-realign {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  align-items: start;
}

.order-card {
  position: relative;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #fff;
  border: 1px solid var(--tc-line);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.order-card.is-active {
  border-color: #2f6fed;
  box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.12);
}

.order-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.order-card__title {
  font-weight: 600;
  font-size: 14px;
}

.order-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--tc-ink-soft);
}

.order-card__warn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 12px;
  color: #c0392b;
}

.order-card__actions {
  position: absolute;
  top: 8px;
  right: 40px;
}

.realign-detail {
  min-height: 420px;
}

.detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.detail-head__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.overview-alert,
.issue-alert {
  margin-bottom: 10px;
}

.issue-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.section-block {
  margin-top: 16px;
}

.section-block__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.section-block__head h4 {
  margin: 0;
  font-size: 14px;
}

.target-card {
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fbfcfe;
  border: 1px solid var(--tc-line);
  border-radius: 8px;
}

.target-card.is-new {
  border-style: dashed;
  border-color: #27ae60;
  background: #f4fbf6;
}

.target-card__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.target-card__count {
  font-size: 13px;
  color: var(--tc-ink-soft);
}

.target-card__actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.target-card__absorbed {
  margin-top: 8px;
  font-size: 12px;
  color: #b9770e;
}

.crack-tip {
  font-size: 12px;
  line-height: 1.8;
}

.submit-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
  padding: 12px 16px;
  background: #f6f8fb;
  border: 1px solid var(--tc-line);
  border-radius: 10px;
}

.submit-bar__tip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.unit-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.unit-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--tc-ink-soft);
  background: #fff;
  border: 1px solid var(--tc-line);
  border-radius: 999px;
}

.unit-item.is-done {
  color: #1e8449;
  border-color: #bfe3cd;
  background: #eaf6ee;
}

@media (max-width: 1100px) {
  .grid-realign {
    grid-template-columns: 1fr;
  }
}
</style>
