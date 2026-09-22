import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VisionConfig } from '../src/config.ts'
import { Vision, resolveSecret } from '../src/vision.ts'

const CONFIG: VisionConfig = { enabled: true, baseUrlEnv: 'V_BASE', apiKeyEnv: 'V_KEY', model: 'deepseek-chat', maxImagesPerRequest: 2, maxImageBytes: 1_000, timeoutMs: 5_000, cacheTtlMs: 60_000 }
const logger = { info: () => undefined, warn: () => undefined }

/** 假 fetch：图片地址返回字节，模型地址返回 completions。 */
function fakeFetch(opts: { imageBytes?: number, imageStatus?: number, modelStatus?: number, modelText?: string | null } = {}) {
  const calls: { url: string, body?: unknown }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) } })
    if (url.includes('/chat/completions')) {
      const status = opts.modelStatus ?? 200
      const body = status === 200 ? { choices: [{ message: { content: opts.modelText === undefined ? '内容：一根烤肠。\n文字：这种肠我都是拿来喂狗的' : opts.modelText } }] } : { error: { message: 'quota' } }
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
    const status = opts.imageStatus ?? 200
    return new Response(new Uint8Array(opts.imageBytes ?? 100), { status, headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xs-vision-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveSecret', () => {
  it('环境变量优先，其次 $DSH_HOME/.env；引号会剥掉；都没有就 undefined', () => {
    writeFileSync(join(dir, '.env'), '# comment\nV_KEY="from-file"\nOTHER=1\n')
    expect(resolveSecret('V_KEY', { V_KEY: 'from-env' }, dir)).toBe('from-env')
    expect(resolveSecret('V_KEY', {}, dir)).toBe('from-file')
    expect(resolveSecret('MISSING', {}, dir)).toBeUndefined()
    expect(resolveSecret('V_KEY', {}, undefined)).toBeUndefined()
  })
})

describe('Vision.describe', () => {
  it('抓图 → 以 data URL 送给模型 → 描述回填；同一张图第二次走缓存不再请求', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const vision = new Vision(CONFIG, { fetch: fetchImpl, env: { V_KEY: 'k', V_BASE: 'https://model.example/v1/' }, logger })
    expect(vision.available()).toBe(true)
    const out = await vision.describe(['https://pbs.twimg.com/media/a.jpg'])
    expect(out).toEqual([{ url: 'https://pbs.twimg.com/media/a.jpg', description: '内容：一根烤肠。\n文字：这种肠我都是拿来喂狗的' }])
    expect(calls.map(call => call.url)).toEqual(['https://pbs.twimg.com/media/a.jpg?name=large', 'https://model.example/v1/chat/completions'])
    const request = calls[1]!.body as { model: string, messages: { content: { type: string, image_url?: { url: string } }[] }[] }
    expect(request.model).toBe('deepseek-chat')
    expect(request.messages[0]!.content[1]!.image_url!.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    await vision.describe(['https://pbs.twimg.com/media/a.jpg'])
    expect(calls).toHaveLength(2)
  })

  it('没有钥匙：不可用，每张图给出原因，不发任何请求', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const vision = new Vision(CONFIG, { fetch: fetchImpl, env: {}, logger })
    expect(vision.available()).toBe(false)
    const out = await vision.describe(['https://pbs.twimg.com/media/a.jpg'])
    expect(out[0]?.error).toContain('钥匙')
    expect(calls).toHaveLength(0)
  })

  it('上限截断、去重；单张失败（图太大 / 抓不到 / 模型报错）只影响那一张', async () => {
    const big = fakeFetch({ imageBytes: 5_000 })
    let vision = new Vision(CONFIG, { fetch: big.fetchImpl, env: { V_KEY: 'k' }, logger })
    const out = await vision.describe(['https://p/1.jpg', 'https://p/1.jpg', 'https://p/2.jpg', 'https://p/3.jpg'])
    expect(out.map(item => item.url)).toEqual(['https://p/1.jpg', 'https://p/2.jpg'])
    expect(out[0]?.error).toContain('图片太大')

    const missing = fakeFetch({ imageStatus: 404 })
    vision = new Vision(CONFIG, { fetch: missing.fetchImpl, env: { V_KEY: 'k' }, logger })
    expect((await vision.describe(['https://p/x.jpg']))[0]?.error).toBe('抓图失败：HTTP 404')

    const broken = fakeFetch({ modelStatus: 429 })
    vision = new Vision(CONFIG, { fetch: broken.fetchImpl, env: { V_KEY: 'k' }, logger })
    expect((await vision.describe(['https://p/y.jpg']))[0]?.error).toContain('读图模型失败：quota')
  })

  it('配置关闭时不可用', () => {
    const vision = new Vision({ ...CONFIG, enabled: false }, { fetch: fakeFetch().fetchImpl, env: { V_KEY: 'k' }, logger })
    expect(vision.available()).toBe(false)
  })
})
