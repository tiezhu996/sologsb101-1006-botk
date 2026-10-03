<script setup lang="ts">
/**
 * 区间调整向导（全屏大弹窗）
 * 步骤：目标分段方案 → 跨界影响预览 → 逐环确认去向并统一提交。
 * - 提交前校验不通过时一条不写，现台账继续可用；
 * - 写入逐环推进、进度落盘，失败后保留调整单与去向，重试从断点继续；
 * - 已写入的调整单可按快照一键回滚回填原归属。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAdjustmentStore } from '@/stores/adjustmentStore'
import { ADJUSTMENT_STATUS_TEXT, type AdjustmentOrder } from '@/types/adjustment'
import AdjustmentTargetEditor from './AdjustmentTargetEditor.vue'
import CrossBoundaryPreview from './CrossBoundaryPreview.vue'
import RingAssignmentTable from './RingAssignmentTable.vue'
import AdjustmentIssuePanel from './AdjustmentIssuePanel.vue'

const props = defineProps<{ modelValue: boolean; orderId: string | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; finished: [] }>()

const adjustmentStore = useAdjustmentStore()

const activeStep = ref(0)
const applying = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const order = computed<AdjustmentOrder | null>(() =>
  props.orderId ? adjustmentStore.orders.find((item) => item.id === props.orderId) ?? null : null
)

watch(
  () => props.orderId,
  () => {
    activeStep.value = 0
  }
)

const isEditable = computed(() => order.value?.status === 'draft' || order.value?.status === 'failed')
const isFinished = computed(() => order.value?.status === 'applied')

const progressPercent = computed(() => {
  if (!order.value || order.value.assignments.length === 0) return 0
  return Math.round((order.value.appliedRingIds.length / order.value.assignments.length) * 100)
})

const liveIssues = computed(() => (order.value ? adjustmentStore.previewIssues(order.value) : []))
const blockerCount = computed(() => liveIssues.value.filter((issue) => issue.level === 'error').length)
const allConfirmed = computed(
  () => !!order.value && order.value.assignments.length > 0 && order.value.assignments.every((a) => a.confirmed)
)

function next(): void {
  if (activeStep.value < 2) activeStep.value += 1
}
function prev(): void {
  if (activeStep.value > 0) activeStep.value -= 1
}

async function submitApply(): Promise<void> {
  if (!order.value) return
  if (!allConfirmed.value) {
    ElMessage.warning('请先在第三步确认每个环片的去向')
    activeStep.value = 2
    return
  }
  applying.value = true
  try {
    const result = await adjustmentStore.apply(order.value.id)
    if (result.status === 'applied') {
      ElMessage.success('区间重划已写入：环号里程、裂缝与速率预警按新分段展示')
      emit('finished')
    } else {
      ElMessage.error(result.lastError || '写入未完成，可从断点继续重试')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败')
  } finally {
    applying.value = false
  }
}

async function retryApply(): Promise<void> {
  if (!order.value) return
  applying.value = true
  try {
    const result = await adjustmentStore.apply(order.value.id)
    if (result.status === 'applied') {
      ElMessage.success('断点续跑完成，区间重划已全部写入')
      emit('finished')
    } else {
      ElMessage.error(result.lastError || '仍有阻断问题，调整未写入')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  } finally {
    applying.value = false
  }
}

async function rollback(): Promise<void> {
  if (!order.value) return
  const confirmed = await ElMessageBox.confirm(
    '将按提交前快照回填原区间、环号里程与裂缝归属；新建分段将删除，复测与建议自动归位。确认回填原归属？',
    '回滚确认',
    { type: 'warning', confirmButtonText: '回填原归属', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await adjustmentStore.rollback(order.value.id)
  ElMessage.success('已按旧备份快照回填原归属')
  emit('finished')
}

async function closeAfterApplied(): Promise<void> {
  visible.value = false
  emit('finished')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="order ? `区间重划向导 · ${order.title}` : '区间重划向导'"
    width="92%"
    top="5vh"
    destroy-on-close
  >
    <template v-if="order">
      <div class="wizard__status">
        <el-tag :type="order.status === 'failed' ? 'danger' : order.status === 'applying' ? 'primary' : 'info'">
          状态：{{ ADJUSTMENT_STATUS_TEXT[order.status] }}
        </el-tag>
        <el-tag v-if="order.kind === 'merge'" effect="plain">方式：相邻区间合并</el-tag>
        <el-tag v-else effect="plain">
          方式：{{ order.splitAtMileage }} m 处拆分
        </el-tag>
        <el-tag v-if="order.status === 'failed'" type="danger" effect="plain">{{ order.lastError }}</el-tag>
      </div>

      <el-result
        v-if="isFinished"
        icon="success"
        title="区间重划已完成"
        sub-title="区间、环号里程与速率预警已按新分段展示；如需恢复，可按快照回填原归属。"
      >
        <template #extra>
          <el-button type="primary" @click="closeAfterApplied">关闭向导</el-button>
          <el-button @click="rollback">按快照回填原归属</el-button>
        </template>
      </el-result>

      <template v-else-if="order.status === 'rolled-back'">
        <el-result
          icon="warning"
          title="已回填原归属"
          sub-title="现台账已恢复为调整前分段；此调整单保留备查，确认无误后可在列表删除。"
        >
          <template #extra>
            <el-button type="primary" @click="visible = false">关闭</el-button>
          </template>
        </el-result>
      </template>

      <template v-else>
        <el-steps :active="activeStep" align-center finish-status="success" style="margin: 8px 0 20px">
          <el-step title="目标分段方案" description="合并 / 拆分后的新区间" />
          <el-step title="跨界影响预览" description="跨界环片 · 裂缝 · 测次" />
          <el-step title="确认去向并提交" description="逐环确认后统一写入" />
        </el-steps>

        <div v-if="order.status === 'applying' || order.status === 'failed'" class="wizard__progress">
          <span>
            写入进度：{{ order.appliedRingIds.length }} / {{ order.assignments.length }} 环（{{ progressPercent }}%）
          </span>
          <el-progress :percentage="progressPercent" :status="order.status === 'failed' ? 'exception' : undefined" />
          <p v-if="order.status === 'failed'" class="wizard__error">
            上次在第 {{ order.appliedRingIds.length + 1 }} 环处停止，调整单与已确认去向已保留，重试将跳过已完成环片。
          </p>
        </div>

        <div v-show="activeStep === 0">
          <AdjustmentTargetEditor :order="order" />
        </div>
        <div v-show="activeStep === 1">
          <CrossBoundaryPreview :order="order" />
        </div>
        <div v-show="activeStep === 2">
          <RingAssignmentTable :order="order" />
          <div style="margin-top: 14px">
            <AdjustmentIssuePanel :order="order" />
          </div>
        </div>
      </template>
    </template>

    <template v-if="order && order.status !== 'applied' && order.status !== 'rolled-back'" #footer>
      <div class="wizard__footer">
        <div>
          <el-button
            v-if="(order.status === 'failed' || order.status === 'applying') && order.snapshot"
            type="warning"
            plain
            @click="rollback"
          >
            回滚已写入部分
          </el-button>
        </div>
        <div>
          <el-button @click="visible = false">关闭</el-button>
          <el-button v-if="activeStep > 0" @click="prev">上一步</el-button>
          <el-button v-if="activeStep < 2" type="primary" @click="next">下一步</el-button>
          <el-button
            v-if="activeStep === 2 && order.status === 'failed'"
            type="warning"
            :loading="applying"
            @click="retryApply"
          >
            从断点继续重试（{{ order.appliedRingIds.length }}/{{ order.assignments.length }}）
          </el-button>
          <el-button
            v-else-if="activeStep === 2"
            type="primary"
            :loading="applying"
            :disabled="!isEditable || blockerCount > 0 || !allConfirmed"
            @click="submitApply"
          >
            统一提交
          </el-button>
          <p v-if="activeStep === 2 && blockerCount > 0" class="wizard__hint">
            存在 {{ blockerCount }} 项阻断问题，调整不写入
          </p>
          <p v-else-if="activeStep === 2 && !allConfirmed" class="wizard__hint">请确认全部环片去向后提交</p>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.wizard__status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.wizard__progress {
  margin-bottom: 16px;
  padding: 12px 14px;
  background: #fbfcfe;
  border: 1px solid var(--tc-line, #dbe3ee);
  border-radius: 10px;
}

.wizard__error {
  margin: 8px 0 0;
  color: #c0392b;
  font-size: 12px;
}

.wizard__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--tc-ink-soft, #5b6b82);
  text-align: right;
}

.wizard__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
