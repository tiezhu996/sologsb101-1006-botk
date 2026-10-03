<script setup lang="ts">
/**
 * 调整向导 · 步骤一：目标区间方案编辑
 * 合并时展示存续区间里程并集；拆分时展示下段（沿用）与上段（新建）。
 * 起止里程 / 线路 / 结构型式修改后实时参与提交前校验。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAdjustmentStore } from '@/stores/adjustmentStore'
import { formatMileage } from '@/types/section'
import { STRUCTURE_TYPES } from '@/types/section'
import type { AdjustmentOrder, AdjustmentTargetSection } from '@/types/adjustment'

const props = defineProps<{ order: AdjustmentOrder }>()

const adjustmentStore = useAdjustmentStore()

const issues = computed(() => adjustmentStore.previewIssues(props.order))
const targetIssues = (target: AdjustmentTargetSection) =>
  issues.value.filter((issue) => issue.refSectionKey === target.key && issue.level === 'error')

async function patchTarget(target: AdjustmentTargetSection, patch: Partial<AdjustmentTargetSection>): Promise<void> {
  try {
    await adjustmentStore.updateTarget(props.order.id, target.key, patch)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新目标区间失败')
  }
}

const canEdit = computed(() => props.order.status === 'draft' || props.order.status === 'failed')
</script>

<template>
  <div class="target-editor">
    <el-alert
      :closable="false"
      show-icon
      type="info"
      :title="
        order.kind === 'merge'
          ? '相邻区间合并：保留起点最前的区间身份并扩展里程，其余来源区间在环片迁出后撤销。'
          : `在 ${formatMileage(order.splitAtMileage ?? 0)} 处拆分：下段沿用原区间身份，上段为新建区间。`
      "
      style="margin-bottom: 14px"
    />

    <el-table :data="order.targets" border stripe row-key="key">
      <el-table-column label="身份" width="120">
        <template #default="{ row }">
          <el-tag v-if="row.survivor" type="success" size="small">沿用 {{ order.kind === 'merge' ? '存续' : '下段' }}</el-tag>
          <el-tag v-else type="warning" size="small">新建上段</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="线路" min-width="120">
        <template #default="{ row }">
          <el-input
            :model-value="row.line"
            :disabled="!canEdit"
            size="small"
            @change="(value: string) => patchTarget(row, { line: value })"
          />
        </template>
      </el-table-column>
      <el-table-column label="起始里程(m)" width="150">
        <template #default="{ row }">
          <el-input-number
            :model-value="row.startMileage"
            :min="0"
            :controls="false"
            :disabled="!canEdit"
            size="small"
            style="width: 120px"
            @change="(value?: number) => value !== undefined && patchTarget(row, { startMileage: value })"
          />
        </template>
      </el-table-column>
      <el-table-column label="终止里程(m)" width="150">
        <template #default="{ row }">
          <el-input-number
            :model-value="row.endMileage"
            :min="0"
            :controls="false"
            :disabled="!canEdit"
            size="small"
            style="width: 120px"
            @change="(value?: number) => value !== undefined && patchTarget(row, { endMileage: value })"
          />
        </template>
      </el-table-column>
      <el-table-column label="里程展示" width="190">
        <template #default="{ row }">{{ formatMileage(row.startMileage) }} ～ {{ formatMileage(row.endMileage) }}</template>
      </el-table-column>
      <el-table-column label="结构型式" width="140">
        <template #default="{ row }">
          <el-select
            :model-value="row.structureType"
            :disabled="!canEdit"
            size="small"
            style="width: 112px"
            @change="(value: AdjustmentTargetSection['structureType']) => patchTarget(row, { structureType: value })"
          >
            <el-option v-for="item in STRUCTURE_TYPES" :key="item" :label="item" :value="item" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="校验" min-width="220">
        <template #default="{ row }">
          <template v-if="targetIssues(row).length === 0">
            <el-tag size="small" type="success">里程方案可提交</el-tag>
          </template>
          <div v-for="issue in targetIssues(row)" :key="issue.code + issue.message" class="target-editor__issue">
            {{ issue.message }}
          </div>
        </template>
      </el-table-column>
    </el-table>

    <p class="muted" style="margin: 10px 0 0">
      调整只改行政分段：环片档案编号、裂缝编号与复测测次均保持原 id，裂缝按环片、复测按裂缝跟随迁移。
    </p>
  </div>
</template>

<style scoped>
.target-editor__issue {
  color: #c0392b;
  font-size: 12px;
  line-height: 1.5;
}
</style>
