<script setup lang="ts">
/**
 * /adjustments 区间重划调整单
 * 线路复检后重划区间（合并 / 拆分）的入口：先建调整单、预览跨界环片/裂缝/测次、
 * 逐环确认去向，再统一提交；失败可断点续跑，完成后可按快照回滚。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, RefreshRight, Sort, View } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import AdjustmentCreateDialog from '@/components/adjustment/AdjustmentCreateDialog.vue'
import AdjustmentWizard from '@/components/adjustment/AdjustmentWizard.vue'
import { useAdjustmentStore } from '@/stores/adjustmentStore'
import { useSectionStore } from '@/stores/sectionStore'
import { formatMileage } from '@/types/section'
import {
  ADJUSTMENT_STATUS_TAG,
  ADJUSTMENT_STATUS_TEXT,
  type AdjustmentOrder
} from '@/types/adjustment'

const adjustmentStore = useAdjustmentStore()
const sectionStore = useSectionStore()

const createVisible = ref(false)
const wizardVisible = ref(false)
const activeOrderId = ref<string | null>(null)

const orders = computed(() => adjustmentStore.orders)

const draftCount = computed(() => orders.value.filter((order) => order.status === 'draft').length)
const appliedCount = computed(() => orders.value.filter((order) => order.status === 'applied').length)
const failedCount = computed(() => adjustmentStore.resumableCount)

function openWizard(orderId: string): void {
  adjustmentStore.selectOrder(orderId)
  activeOrderId.value = orderId
  wizardVisible.value = true
}

function onCreated(orderId: string): void {
  openWizard(orderId)
}

function sourceText(order: AdjustmentOrder): string {
  const names = order.sourceSectionIds
    .map((id) => sectionStore.sectionById.get(id))
    .filter(Boolean)
    .map((section) => `${section!.line} ${formatMileage(section!.startMileage)}`)
  return names.length > 0 ? names.join('、') : '（来源区间已删除）'
}

function targetText(order: AdjustmentOrder): string {
  return order.targets
    .map((target) => `${target.line} ${formatMileage(target.startMileage)}～${formatMileage(target.endMileage)}`)
    .join('；')
}

function progressText(order: AdjustmentOrder): string {
  if (order.assignments.length === 0) return '0/0'
  return `${order.appliedRingIds.length}/${order.assignments.length}`
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function removeOrder(order: AdjustmentOrder): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    order.snapshot
      ? '该调整单已写入台账，删除前需先回滚。确认删除调整单记录？'
      : '删除草稿调整单不会影响现台账，确认删除？',
    '删除调整单',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  try {
    await adjustmentStore.remove(order.id)
    ElMessage.success('调整单已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

async function rollbackFromList(order: AdjustmentOrder): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    '按提交前快照回填原归属，确认执行？',
    '回滚确认',
    { type: 'warning', confirmButtonText: '回填原归属', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await adjustmentStore.rollback(order.id)
  ElMessage.success('已回填原归属')
}

function rowKey(order: AdjustmentOrder): string {
  return order.id
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">区间重划调整单</h2>
        <p class="page-head__desc">
          线路复检后合并相邻区间或在里程点拆分：先预览跨界环片、裂缝与受影响测次，逐环确认去向后统一提交。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button type="primary" :icon="Plus" :disabled="sectionStore.sections.length === 0" @click="createVisible = true">
          新建调整单
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="调整单总数" :value="orders.length" suffix="张" icon="Files" tone="primary" />
      <StatBadge label="待确认草稿" :value="draftCount" suffix="张" icon="Histogram" tone="info" />
      <StatBadge label="可断点续跑" :value="failedCount" suffix="张" icon="WarningFilled" tone="danger" />
      <StatBadge label="已完成" :value="appliedCount" suffix="张" icon="CircleCheckFilled" tone="success" />
    </div>

    <div class="panel">
      <h3 class="panel-title">调整单列表</h3>
      <EmptyPanel
        v-if="orders.length === 0"
        title="还没有区间调整单"
        :description="sectionStore.sections.length === 0 ? '请先在区间台账建立区间与环片。' : '新建调整单后，可先预览跨界影响再确认去向。'"
        action-text="新建调整单"
        compact
        @action="createVisible = true"
      />
      <el-table v-else :data="orders" border stripe :row-key="rowKey">
        <el-table-column prop="title" label="调整单" min-width="200">
          <template #default="{ row }">
            <strong>{{ row.title }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="方式" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.kind === 'merge' ? '相邻合并' : '里程点拆分' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源区间" min-width="180">
          <template #default="{ row }">{{ sourceText(row) }}</template>
        </el-table-column>
        <el-table-column label="调整后分段" min-width="260">
          <template #default="{ row }">{{ targetText(row) }}</template>
        </el-table-column>
        <el-table-column label="写入进度" width="100">
          <template #default="{ row }">{{ progressText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="ADJUSTMENT_STATUS_TAG[row.status as AdjustmentOrder['status']]">
              {{ ADJUSTMENT_STATUS_TEXT[row.status as AdjustmentOrder['status']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="150">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :icon="View" @click="openWizard(row.id)">
              {{ row.status === 'failed' || row.status === 'applying' ? '继续处理' : '打开' }}
            </el-button>
            <el-button
              v-if="row.snapshot && row.status !== 'rolled-back'"
              size="small"
              text
              type="warning"
              :icon="RefreshRight"
              @click="rollbackFromList(row)"
            >
              回填原归属
            </el-button>
            <el-button size="small" text :icon="Sort" @click="removeOrder(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <p class="muted" style="margin: 12px 0 0">
        说明：里程重叠、环号碰撞或迁移后环片/裂缝找不到所属时，调整不写入、现台账继续可用；写入失败后调整单与已确认去向保留，可从断点继续。
      </p>
    </div>

    <AdjustmentCreateDialog v-model="createVisible" @created="onCreated" />
    <AdjustmentWizard v-model="wizardVisible" :order-id="activeOrderId" />
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}
</style>
