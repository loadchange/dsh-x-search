/**
 * 账号安全阀：滚动窗口配额 + 每日上限 + 最小间隔。
 *
 * 这不是性能参数，是用自己账号刷网页接口时的自我约束——X 的限流是按账号的，
 * 撞上去先是 429，再是要求验证，最后是封号。日计数落盘，重启不清零。
 * @module
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LimiterOptions {
  perWindow: number
  windowMs: number
  perDay: number
  minSpacingMs: number
  /** 注入时钟，便于测试。 */
  now?: () => number
  /** 日计数落盘路径；不给就只在内存里。 */
  persistPath?: string
}

export type AcquireResult =
  | { ok: true }
  | { ok: false, reason: 'window' | 'day' | 'spacing', retryAfterMs: number }

export interface LimiterStatus {
  usedInWindow: number
  perWindow: number
  usedToday: number
  perDay: number
  day: string
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 令牌桶式限流器。`acquire()` 成功即占用一个名额（同步、不可撤销）。 */
export class RateLimiter {
  private readonly opts: LimiterOptions
  private readonly now: () => number
  private stamps: number[] = []
  private day: { date: string, count: number }

  constructor(opts: LimiterOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.day = this.load()
  }

  /** 试着占一个名额。 */
  acquire(): AcquireResult {
    const at = this.now()
    const today = utcDay(at)
    if (this.day.date !== today) this.day = { date: today, count: 0 }
    this.stamps = this.stamps.filter(stamp => at - stamp < this.opts.windowMs)

    const last = this.stamps[this.stamps.length - 1]
    if (last !== undefined && at - last < this.opts.minSpacingMs) {
      return { ok: false, reason: 'spacing', retryAfterMs: this.opts.minSpacingMs - (at - last) }
    }
    if (this.day.count >= this.opts.perDay) {
      const nextDay = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1)
      return { ok: false, reason: 'day', retryAfterMs: Math.max(1_000, nextDay - at) }
    }
    if (this.stamps.length >= this.opts.perWindow) {
      const oldest = this.stamps[0]!
      return { ok: false, reason: 'window', retryAfterMs: Math.max(1_000, this.opts.windowMs - (at - oldest)) }
    }
    this.stamps.push(at)
    this.day.count += 1
    this.save()
    return { ok: true }
  }

  status(): LimiterStatus {
    const at = this.now()
    const usedInWindow = this.stamps.filter(stamp => at - stamp < this.opts.windowMs).length
    const today = utcDay(at)
    return {
      usedInWindow,
      perWindow: this.opts.perWindow,
      usedToday: this.day.date === today ? this.day.count : 0,
      perDay: this.opts.perDay,
      day: today,
    }
  }

  private load(): { date: string, count: number } {
    const fallback = { date: utcDay(this.now()), count: 0 }
    if (this.opts.persistPath === undefined) return fallback
    try {
      const raw = JSON.parse(readFileSync(this.opts.persistPath, 'utf8')) as { date?: unknown, count?: unknown }
      if (typeof raw.date === 'string' && typeof raw.count === 'number' && raw.count >= 0) return { date: raw.date, count: Math.floor(raw.count) }
    } catch {
      // 没有或读不出：从零计。
    }
    return fallback
  }

  private save(): void {
    if (this.opts.persistPath === undefined) return
    try {
      mkdirSync(dirname(this.opts.persistPath), { recursive: true })
      const tmp = `${this.opts.persistPath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.day), { mode: 0o600 })
      renameSync(tmp, this.opts.persistPath)
    } catch {
      // 落盘失败不该挡住请求；最坏是重启后日计数偏低。
    }
  }
}
