import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const abs = resolvePath(here, '..', 'src', specifier.slice(2))
    return nextResolve(pathToFileURL(abs).href, context)
  }
  return nextResolve(specifier, context)
}
