/** 供 tsx 运行验证脚本时解析源码里的 @/ 别名（仅测试用，通过 register 链式注册） */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./alias-hook.mts', pathToFileURL('./scripts/'))
