import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // web streams (TransformStream/TextEncoder) 在 worker 线程池里偶发崩溃，改用子进程池
    pool: "forks",
    include: ["test/**/*.test.ts"],
  },
});
