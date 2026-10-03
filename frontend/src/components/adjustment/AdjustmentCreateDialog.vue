<script setup lang="ts">
/**
 * 新建区间调整单弹窗：选择合并 / 拆分方式与来源区间。
 * 创建后进入去向确认向导，不直接改动正式台账。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAdjustmentStore } from '@/stores/adjustmentStore'
import { useSectionStore } from '@/stores/sectionStore'
import { formatMileage } from '@/types/section'
import type { AdjustmentKind } from '@/types/adjustment'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [orderId: string]
}>()

const adjustmentStore = useAdjustmentStore()
const sectionStore = useSectionStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)
const form = reactive<{
  kind: AdjustmentKind
  title: string
  mergeSectionIds: string[]
  splitSectionId: string
  splitAtMileage: number | null
}>({
  kind: 'merge',
  title: '',
  mergeSectionIds: [],
  splitSectionId: '',
  splitAtMileage: null
})

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const sectionOptions = computed(() =>
  sectionStore.sections.map((section) => ({
    label: `${section.line} · ${formatMileage(section.startMileage)}～${formatMileage(section.endMileage)}（${section.structureType}）`,
    value: section.id
  }))
)

const splitSection = computed(() =>
  form.splitSectionId ? sectionStore.sectionById.get(form.splitSectionId) ?? null : null
)

const rules = computed<FormRules>(() => ({
  title: [{ required: true, message: '请填写调整单标题', trigger: 'blur' }],
  mergeSectionIds: [
    {
      validator: (_rule, _value, callback) => {
        if (form.kind !== 'merge') return callback()
        if (form.mergeSectionIds.length < 2) callback(new Error('合并至少选择两个区间'))
        else callback()
      },
      trigger: 'change'
    }
  ],
  splitSectionId: [
    {
      validator: (_rule, _value, callback) => {
        if (form.kind !== 'split') return callback()
        if (!form.splitSectionId) callback(new Error('请选择要拆分的区间'))
        else callback()
      },
      trigger: 'change'
    }
  ],
  splitAtMileage: [
    {
      validator: (_rule, value, callback) => {
        if (form.kind !== 'split') return callback()
        const p = Number(value)
        if (!Number.isFinite(p)) return callback(new Error('请填写拆分里程点'))
        if (splitSection.value && (p <= splitSection.value.startMileage || p >= splitSection.value.endMileage)) {
          return callback(new Error('拆分点必须严格位于区间起止里程之间'))
        }
        callback()
      },
      trigger: 'change'
    }
  ]
}))

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    const first = sectionStore.sections[0]
    Object.assign(form, {
      kind: 'merge',
      title: '',
      mergeSectionIds: sectionStore.sections.slice(0, 2).map((section) => section.id),
      splitSectionId: first?.id ?? '',
      splitAtMileage: null
    })
  }
)

watch(
  () => [form.kind, form.mergeSectionIds, form.splitSectionId] as const,
  () => {
    if (form.title.startsWith('合并 ') || form.title.startsWith('拆分 ') || form.title === '') {
      form.title = defaultTitle()
    }
  }
)

function defaultTitle(): string {
  if (form.kind === 'merge') {
    const lines = form.mergeSectionIds
      .map((id) => sectionStore.sectionById.get(id)?.line)
      .filter(Boolean)
    return lines.length > 0 ? `合并 ${Array.from(new Set(lines)).join('/')} 相邻区间` : '合并相邻区间'
  }
  const section = sectionStore.sectionById.get(form.splitSectionId)
  return section ? `拆分 ${section.line} 区间于 ${form.splitAtMileage ?? '?'} m` : '按里程点拆分区间'
}

watch(
  () => form.splitAtMileage,
  () => {
    if (form.kind === 'split') form.title = defaultTitle()
  }
)

async function submit(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const order = await adjustmentStore.createDraft({
      kind: form.kind,
      title: form.title,
      sourceSectionIds: form.kind === 'merge' ? form.mergeSectionIds : [form.splitSectionId],
      splitAtMileage: form.kind === 'split' ? form.splitAtMileage : null
    })
    ElMessage.success('调整单已创建，请逐环确认去向')
    visible.value = false
    emit('created', order.id)
  } catch (error) {
    ElMessage.error(`创建调整单失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="新建区间调整单" width="560px" destroy-on-close>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="112px">
      <el-form-item label="调整方式">
        <el-radio-group v-model="form.kind">
          <el-radio-button value="merge">相邻区间合并</el-radio-button>
          <el-radio-button value="split">里程点拆分</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="form.kind === 'merge'">
        <el-form-item label="合并区间" prop="mergeSectionIds">
          <el-select
            v-model="form.mergeSectionIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            placeholder="选择两个及以上相邻区间"
            style="width: 100%"
          >
            <el-option v-for="item in sectionOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="合并后保留起点最前的区间作为存续区间，其余区间在环片全部迁出后撤销；环片与裂缝实体身份不变。"
          />
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label="拆分区间" prop="splitSectionId">
          <el-select v-model="form.splitSectionId" filterable placeholder="选择要拆分的区间" style="width: 100%">
            <el-option v-for="item in sectionOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="splitSection" label="原区间里程">
          <span class="muted">
            {{ formatMileage(splitSection.startMileage) }} ～ {{ formatMileage(splitSection.endMileage) }}
          </span>
        </el-form-item>
        <el-form-item label="拆分里程点(m)" prop="splitAtMileage">
          <el-input-number v-model="form.splitAtMileage" :min="0" :step="10" style="width: 100%" />
        </el-form-item>
        <el-form-item>
          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="原区间缩短为下段（沿用原区间身份），上段预分配新身份；里程恰等于拆分点的环默认归入上段，需人工确认。"
          />
        </el-form-item>
      </template>

      <el-form-item label="调整单标题" prop="title">
        <el-input v-model="form.title" placeholder="如：合并 1号线 相邻区间" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">创建并确认去向</el-button>
    </template>
  </el-dialog>
</template>
