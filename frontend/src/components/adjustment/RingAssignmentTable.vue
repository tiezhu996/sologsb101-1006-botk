<script setup lang="ts">
/**
 * 调整向导 · 逐环去向确认表
 * 每一环展示现归属、里程、随迁裂缝/测次与目标区间选择；
 * 跨界环默认置顶要求人工确认，全部环确认后才允许统一提交。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAdjustmentStore, type AssignmentView } from '@/stores/adjustmentStore'
import { formatMileage } from '@/types/section'
import type { AdjustmentOrder } from '@/types/adjustment'

const props = defineProps<{ order: AdjustmentOrder }>()

const adjustmentStore = useAdjustmentStore()

const views = computed<AssignmentView[]>(() => adjustmentStore.assignmentViews(props.order))
const issues = computed(() => adjustmentStore.previewIssues(props.order))

const confirmedCount = computed(
  () => props.order.assignments.filter((assignment) => assignment.confirmed).length
)
const totalCount = computed(() => props.order.assignments.length)
const unconfirmedCrossCount = computed(
  () =>
    props.order.assignments.filter((assignment) => assignment.crossBoundary && !assignment.confirmed)
      .length
)

const canEdit = computed(() => props.order.status === 'draft' || props.order.status === 'failed')

function rowKey(view: AssignmentView): string {
  return view.assignment.ringId
}

function rowIssues(view: AssignmentView) {
  return view.issues.filter((issue) => issue.level === 'error')
}

async function changeTarget(view: AssignmentView, targetKey: string): Promise<void> {
  try {
    await adjustmentStore.setRingTarget(props.order.id, view.assignment.ringId, targetKey)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '去向修改失败')
  }
}

async function changeConfirmed(view: AssignmentView, value: boolean | string | number): Promise<void> {
  try {
    await adjustmentStore.confirmRing(props.order.id, view.assignment.ringId, Boolean(value))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认失败')
  }
}

async function confirmCross(): Promise<void> {
  await adjustmentStore.confirmAll(props.order.id, 'crossBoundary', true)
  ElMessage.success('跨界环片去向已全部确认')
}

async function confirmAllRings(): Promise<void> {
  await adjustmentStore.confirmAll(props.order.id, 'all', true)
  ElMessage.success('全部环片去向已确认')
}

const blockerCount = computed(() => issues.value.filter((issue) => issue.level === 'error').length)
</script>

<template>
  <div class="assign-table">
    <div class="assign-table__head">
      <div class="assign-table__progress">
        <el-tag type="info" effect="plain">已确认 {{ confirmedCount }} / {{ totalCount }} 环</el-tag>
        <el-tag v-if="unconfirmedCrossCount > 0" type="danger" effect="plain">
          跨界环待确认 {{ unconfirmedCrossCount }} 环
        </el-tag>
        <el-tag v-if="blockerCount > 0" type="danger" effect="plain">阻断问题 {{ blockerCount }} 项</el-tag>
      </div>
      <div v-if="canEdit" class="assign-table__actions">
        <el-button size="small" @click="confirmCross">一键确认跨界环</el-button>
        <el-button size="small" type="primary" plain @click="confirmAllRings">全部确认</el-button>
      </div>
    </div>

    <el-table :data="views" border stripe :row-key="rowKey" :row-class-name="() => ''" size="small" style="margin-top: 12px">
      <el-table-column label="跨界" width="70" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.assignment.crossBoundary" size="small" type="danger">跨界</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="环号" width="90">
        <template #default="{ row }">第 {{ row.ring?.ringNo ?? '—' }} 环</template>
      </el-table-column>
      <el-table-column label="里程" width="120">
        <template #default="{ row }">{{ row.ring ? formatMileage(row.ring.mileage) : '—' }}</template>
      </el-table-column>
      <el-table-column label="原属" min-width="140">
        <template #default="{ row }">
          {{ row.fromSection ? `${row.fromSection.line} ${formatMileage(row.fromSection.startMileage)}` : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="去向（新分段）" min-width="260">
        <template #default="{ row }">
          <el-select
            :model-value="row.assignment.targetKey"
            :disabled="!canEdit"
            size="small"
            style="width: 100%"
            @change="(value: string) => changeTarget(row, value)"
          >
            <el-option
              v-for="target in order.targets"
              :key="target.key"
              :label="`${target.survivor ? '沿用' : '新建'} · ${target.line} ${formatMileage(target.startMileage)}～${formatMileage(target.endMileage)}`"
              :value="target.key"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="裂缝/测次" width="100" align="center">
        <template #default="{ row }">{{ row.cracks.length }} / {{ row.surveyCount }}</template>
      </el-table-column>
      <el-table-column label="确认去向" width="90" align="center">
        <template #default="{ row }">
          <el-checkbox
            :model-value="row.assignment.confirmed"
            :disabled="!canEdit"
            @change="(value: boolean | string | number) => changeConfirmed(row, value)"
          />
        </template>
      </el-table-column>
      <el-table-column label="校验提示" min-width="220">
        <template #default="{ row }">
          <span v-if="rowIssues(row).length === 0" class="muted">正常</span>
          <div v-for="issue in rowIssues(row)" :key="issue.code + issue.message" class="assign-table__issue">
            {{ issue.message }}
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.assign-table__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.assign-table__progress,
.assign-table__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.assign-table__issue {
  color: #c0392b;
  font-size: 12px;
  line-height: 1.5;
}
</style>
