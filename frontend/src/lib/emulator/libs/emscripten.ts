import type { RetroArchEmscriptenModuleOptions } from '../types/retroarch-emscripten.ts'
import { DEBUG } from '$lib/config/debug';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('Emscripten');

export function getEmscriptenModuleOverrides(overrides: RetroArchEmscriptenModuleOptions) {
  let resolveRunDependenciesPromise: () => void
  const runDependenciesPromise = new Promise<void>((resolve) => {
    resolveRunDependenciesPromise = resolve
  })

  const emscriptenModuleOverrides: RetroArchEmscriptenModuleOptions = {
    noExitRuntime: false,
    noInitialRun: true,

    locateFile(file) {
      return file
    },

    // the return value of `monitorRunDependencies` seems to be misused here, but it works for now
    async monitorRunDependencies(left?: number) {
      if (left === 0) {
        resolveRunDependenciesPromise()
      }
      return await runDependenciesPromise
    },

    print(...args: unknown[]) {
      // Filter out noisy RetroArch info messages
      if (!DEBUG()) {
        return; // Suppress all emulator output in production
      }
      const message = args.join(' ');
      if (message.includes('[INFO]')) {
        return; // Suppress all [INFO] messages even in DEBUG mode
      }
      logger.info(String(args.join(' ')))
    },

    printErr(...args: unknown[]) {
      logger.error(String(args.join(' ')))
    },

    // @ts-expect-error do not throw error when exit
    quit(status: unknown, toThrow: unknown) {
      if (status && DEBUG()) {
        logger.info(String(status), String(toThrow))
      }
    },

    ...overrides,
  }
  return emscriptenModuleOverrides
}
