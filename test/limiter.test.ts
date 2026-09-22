import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/limiter.ts'

function clock(start: number): { now: () => number, tick: (ms: number) => void } {
  let t = start
  return { now: () => t, tick: (ms) => { t += ms } }
}

const T0 = Date.UTC(2026, 8, 22, 10, 0, 0)

describe('RateLimiter', () => {
  it('最小间隔：连着两次第二次被拒，等够了就放行', () => {
    const c = clock(T0)
    const limiter = new RateLimiter({ perWindow: 10, windowMs: 60_000, perDay: 100, minSpacingMs: 1_500, now: c.now })
    expect(limiter.acquire()).toEqual({ ok: true })
    const denied = limiter.acquire()
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.reason).toBe('spacing')
      expect(denied.retryAfterMs).toBe(1_500)
    }
    c.tick(1_500)
    expect(limiter.acquire()).toEqual({ ok: true })
  })

  it('滚动窗口：窗口满了拒绝，最早那次滑出窗口后恢复', () => {
    const c = clock(T0)
    const limiter = new RateLimiter({ perWindow: 3, windowMs: 10_000, perDay: 100, minSpacingMs: 0, now: c.now })
    for (let i = 0; i < 3; i += 1) { expect(limiter.acquire().ok).toBe(true); c.tick(1_000) }
    const denied = limiter.acquire()
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('window')
    c.tick(7_000) // 第一次是 T0，现在 T0+10s，刚好滑出
    expect(limiter.acquire().ok).toBe(true)
  })

  it('日上限：按 UTC 日计，跨日清零，且落盘后重建还记得', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xs-limiter-'))
    try {
      const path = join(dir, 'limiter.json')
      const c = clock(T0)
      const a = new RateLimiter({ perWindow: 100, windowMs: 1_000, perDay: 2, minSpacingMs: 0, now: c.now, persistPath: path })
      expect(a.acquire().ok).toBe(true)
      c.tick(2_000)
      expect(a.acquire().ok).toBe(true)
      c.tick(2_000)
      const denied = a.acquire()
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('day')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ date: '2026-09-22', count: 2 })

      // 重启：同一天，计数从文件回来
      const b = new RateLimiter({ perWindow: 100, windowMs: 1_000, perDay: 2, minSpacingMs: 0, now: c.now, persistPath: path })
      expect(b.status().usedToday).toBe(2)
      expect(b.acquire().ok).toBe(false)
      // 跨日
      c.tick(24 * 3_600_000)
      expect(b.acquire().ok).toBe(true)
      expect(b.status()).toMatchObject({ usedToday: 1, day: '2026-09-23' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
