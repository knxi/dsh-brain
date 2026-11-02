import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const dir = new URL('./', import.meta.url)
const a = new URL('a.mjs', dir).href
const b = new URL('b.mjs', dir)

writeFileSync(b, "export const V='b-old'\n")
const m1 = await import(a + '?v=1')
console.log('m1 =', m1.A)
writeFileSync(b, "export const V='b-new'\n")
const m2 = await import(a + '?v=2')
console.log('m2 =', m2.A)
