<script setup lang="ts">
/**
 * 提交前校验问题面板：阻断错误（红）与提示（黄）分组展示。
 * 存在任一阻断问题时调整不写入、现台账继续可用。
 */
import { computed } from 'vue'
import { useAdjustmentStore } from '@/stores/adjustmentStore'
import type { AdjustmentOrder } from '@/types/adjustment'

const props = defineProps<{ order: AdjustmentOrder }>()

const adjustmentStore = useAdjustmentStore()

const issues = computed(() => adjustmentStore.previewIssues(props.order))
const errors = computed(() => issues.value.filter((issue) => issue.level === 'error'))
const warnings = computed(() => issues.value.filter((issue) => issue.level === 'warning'))
</script>

<template>
  <div class="issue-panel">
    <el-alert
      v-if="errors.length > 0"
      type="error"
      show-icon
      :closable="false"
      :title="`${errors.length} 项阻断问题：本次调整不会写入，现台账继续可用`"
      style="margin-bottom: 10px"
    >
      <ul class="issue-panel__list">
        <li v-for="(issue, index) in errors" :key="`e-${index}`">{{ issue.message }}</li>
      </ul>
    </el-alert>
    <el-alert
      v-if="warnings.length > 0"
      type="warning"
      show-icon
      :closable="false"
      title="提交前请人工核对以下提示"
      style="margin-bottom: 10px"
    >
      <ul class="issue-panel__list">
        <li v-for="(issue, index) in warnings" :key="`w-${index}`">{{ issue.message }}</li>
      </ul>
    </el-alert>
    <el-alert
      v-if="issues.length === 0"
      type="success"
      show-icon
      :closable="false"
      title="校验通过：里程无重叠、环号无碰撞，全部环片迁移后均可归属。"
    />
  </div>
</template>

<style scoped>
.issue-panel__list {
  margin: 6px 0 0;
  padding-left: 18px;
  line-height: 1.7;
}
</style>
