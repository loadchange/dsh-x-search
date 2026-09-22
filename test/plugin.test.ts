import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { XSearchConfig, resolveCookiesFile, resolveDataDir } from '../src/config.ts'
import * as plugin from '../src/index.ts'

function sources(): { file: string, lines: string[] }[] {
  const out: { file: string, lines: string[] }[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) out.push({ file: path.split('/src/')[1]!, lines: readFileSync(path, 'utf8').split('\n') })
    }
  }
  walk(join(import.meta.dirname, '..', 'src'))
  return out
}

describe('插件形状', () => {
  it('name / inject / apply / Config 齐全，且 inject 是数组（cordis 4 只认数组）', () => {
    expect(plugin.name).toBe('x-search')
    expect(Array.isArray(plugin.inject)).toBe(true)
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBe(XSearchConfig)
  })

  it('配置默认值：只绑回环、限流保守、模型开着、不落调试响应', () => {
    const config = new XSearchConfig({} as never)
    expect(config.webHost).toBe('127.0.0.1')
    expect(config.webPort).toBe(31890)
    expect(config.browser.headless).toBe(true)
    expect(config.limits.perWindow).toBeLessThanOrEqual(50)
    expect(config.limits.minSpacingMs).toBeGreaterThan(0)
    expect(config.llm.enabled).toBe(true)
    expect(config.debugDumpDir).toBe('')
    expect(resolveDataDir(config, '/home/u/.dsh')).toBe('/home/u/.dsh/x-search')
    expect(resolveDataDir({ dataDir: '/data/x' }, '/home/u/.dsh')).toBe('/data/x')
    expect(resolveCookiesFile(config, '/data/x')).toBe('/data/x/cookies.json')
    expect(resolveCookiesFile({ cookiesFile: '/etc/x/c.json' }, '/data/x')).toBe('/etc/x/c.json')
  })
})

describe('静态守卫：发出去不管的 Promise 必须接住拒绝（dsh 宿主 0.1.5-rc.2 起对 unhandledRejection 2 秒内杀进程）', () => {
  it('每个 `void xxx(...)` 调用后几行内都有 .catch', () => {
    const offenders: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, index) => {
        if (!/\bvoid\s+[\w.]+\(/.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) return
        const window = lines.slice(index, index + 6).join('\n')
        if (!window.includes('.catch(')) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('async 回调不许直接传给 on / once / setTimeout / setInterval', () => {
    const offenders: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, i) => {
        if (/(\.on|\.once|setTimeout|setInterval|setImmediate)\([^)]*\basync\b/.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('.then 只给一个参数时，同一语句后几行内必须有 .catch', () => {
    const offenders: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, i) => {
        if (!line.includes('.then(')) return
        const window = lines.slice(i, i + 6).join('\n')
        const twoArgs = /\.then\(\s*\n?[\s\S]*?\),?\s*\n?\s*\((error|err|e)\b/.test(window) || /\.then\([\s\S]*?\},\s*\n\s*\((error|err)/.test(window) || /\.then\([^,]+,\s*[^)]+\)/.test(line)
        if (!twoArgs && !window.includes('.catch(')) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('静态守卫：cookie 值不进日志与错误', () => {
  it('src 里没有任何地方把 auth_token / ct0 的值拼进字符串', () => {
    const offenders: string[] = []
    for (const { file, lines } of sources()) {
      lines.forEach((line, i) => {
        if (/\$\{[^}]*(auth_token|ct0|cookies\[|out\[name\])/.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('随仓库走的客户端 skill（skills/dsh-x）与插件清单', () => {
  const root = join(import.meta.dirname, '..')
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')

  it('plugin.json 与 package.json 版本一致，市场清单指向仓库根', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string, version: string, author: { name: string } }
    const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { plugins: { name: string, source: string }[] }
    expect(manifest.name).toBe('dsh-x')
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.author.name.length).toBeGreaterThan(0)
    expect(market.plugins).toEqual([expect.objectContaining({ name: 'dsh-x', source: './' })])
  })

  it('SKILL.md 有 frontmatter，脚本能被 Python 解析，且不带指向别的仓库的 UA', () => {
    const skill = read('skills/dsh-x/SKILL.md')
    expect(skill.startsWith('---\nname: dsh-x\n')).toBe(true)
    const script = read('skills/dsh-x/scripts/dsh_x.py')
    expect(script).toContain('+https://github.com/loadchange/dsh-x-search')
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: script })
  })
})
