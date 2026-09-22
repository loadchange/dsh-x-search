import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 测试全程禁网络、禁浏览器、禁真实 cookie：解析器吃夹具，服务层吃假浏览器。
    environment: 'node',
    testTimeout: 15_000,
  },
})
