<script setup lang="ts">
/**
 * 调整向导 · 跨界影响预览
 * 集中展示跨越行政边界的环片、其上裂缝与受影响测次，
 * 供提交前核对"裂缝与复测跟随同一实体环片迁移"。
 */
import { computed } from 'vue'
import { useAdjustmentStore, type AssignmentView } from '@/stores/adjustmentStore'
import { formatMileage } from '@/types/section'
import type { AdjustmentOrder } from '@/types/adjustment'

const props = defineProps<{ order: AdjustmentOrder }>()

const adjustmentStore = useAdjustmentStore()

const views = computed<AssignmentView[]>(() => adjustmentStore.crossBoundaryViews(props.order))
const affectedRings = computed(() => views.value.length)
const affectedCracks = computed(() => views.value.reduce((sum, view) => sum + view.cracks.length, 0))
const affectedSurveys = computed(() => adjustmentStore.affectedSurveyCount(props.order))

function rowKey(view: AssignmentView): string {
  return view.assignment.ringId
}
</script>

<template>
  <div class="cross-preview">
    <div class="cross-preview__stats">
      <el-tag type="warning" effect="plain">跨界环片 {{ affectedRings }} 环</el-tag>
      <el-tag type="warning" effect="plain">裂缝 {{ affectedCracks }} 条</el-tag>
      <el-tag type="warning" effect="plain">受影响测次 {{ affectedSurveys }} 次</el-tag>
      <span class="muted">裂缝与测次编号、id 均不变，仅跟随环片切换区间归属。</span>
    </div>

    <el-table :data="views" border stripe :row-key="rowKey" size="small" style="margin-top: 12px">
      <el-table-column label="环号" width="90">
        <template #default="{ row }">第 {{ row.ring?.ringNo ?? '—' }} 环</template>
      </el-table-column>
      <el-table-column label="里程" width="120">
        <template #default="{ row }">{{ row.ring ? formatMileage(row.ring.mileage) : '—' }}</template>
      </el-table-column>
      <el-table-column label="原属区间" min-width="150">
        <template #default="{ row }">
          {{ row.fromSection ? `${row.fromSection.line} ${formatMileage(row.fromSection.startMileage)}` : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="去向区间" min-width="170">
        <template #default="{ row }">
          <el-tag size="small" :type="row.target && row.target.survivor ? 'success' : 'warning'">
            {{ row.target ? `${row.target.line} ${formatMileage(row.target.startMileage)}～${formatMileage(row.target.endMileage)}` : '未分配' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="随迁裂缝 / 测次" width="150">
        <template #default="{ row }">
          <span>{{ row.cracks.length }} 条 / {{ row.surveyCount }} 次</span>
        </template>
      </el-table-column>
      <el-table-column label="裂缝编号" min-width="200">
        <template #default="{ row }">
          <span v-if="row.cracks.length === 0" class="muted">无裂缝</span>
          <el-tag
            v-for="crack in row.cracks"
            :key="crack.id"
            size="small"
            effect="plain"
            style="margin: 2px"
          >
            {{ crack.code }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.cross-preview__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
