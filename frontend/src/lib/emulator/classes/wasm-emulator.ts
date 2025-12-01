import { systemCoreMap } from '../constants/system.ts'
import { getGlobalOptions, resetGlobalOptions, updateGlobalOptions } from '../libs/options.ts'
import { checkIsAborted, getResult, isResolvableFileInput, merge } from '../libs/utils.ts'
import { vendors } from '../libs/vendors.ts'
import type {
  WasmEmulatorLaunchOptions,
  WasmEmulatorLaunchRomOptions,
  WasmEmulatorOptions,
  WasmEmulatorOptionsPartial,
} from '../types/wasm-emulator-options'
import type { RetroArchCommand } from '../types/retroarch-command'
import { EmulatorOptions } from './emulator-options.ts'
import { Emulator } from './emulator.ts'
import { ResolvableFile, type ResolvableFileInput } from './resolvable-file.ts'

export class WasmEmulator {
  static readonly WasmEmulator = WasmEmulator
  static readonly vendors = vendors

  private emulator: Emulator | undefined
  private emulatorOptions: EmulatorOptions | undefined
  private options: WasmEmulatorOptions

  private constructor(options: WasmEmulatorLaunchOptions) {
    const mergedOptions = {} as unknown as WasmEmulatorOptions
    merge(mergedOptions, getGlobalOptions(), options)
    this.options = mergedOptions
  }

  static clearCache() {
    EmulatorOptions.resetCacheStore()
  }

  /**
   * Update the global options for `WasmEmulator`, so everytime the `WasmEmulator.launch` method or shortcuts like `WasmEmulator.nes` is called, the default options specified here will be used.
   *
   * You may want to specify how to resolve ROMs and RetroArch cores here.
   *
   * @example
   * ```js
   * WasmEmulator.configure({
   *   resolveRom({ file }) {
   *     return `https://example.com/roms/${file}`
   *   },
   *   // other configuation can also be specified here
   * })
   * ```
   */
  static configure(options: WasmEmulatorOptionsPartial) {
    updateGlobalOptions(options)
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for GB emulation.
   *
   * It will use mgba as the default core for emulation.
   */
  static async gb(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('gb', options)
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for GBA emulation.
   *
   * It will use mgba as the default core for emulation.
   */
  static async gba(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('gba', options)
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for GBC emulation.
   *
   * It will use mgba as the default core for emulation.
   */
  static async gbc(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('gbc', options)
  }

  /**
   * Launch an emulator and return a `Promise` of the instance of the emulator.
   *
   * @example
   * A simple example:
   * ```js
   * const emulator = await WasmEmulator.launch({
   *   core: 'fceumm',
   *   rom: 'flappybird.nes',
   * })
   * ```
   *
   * @example
   * A more complex one:
   * ```js
   * const emulator = await WasmEmulator.launch({
   *   element: document.querySelector('.emulator-canvas'),
   *   core: 'fbneo',
   *   rom: ['mslug.zip'],
   *   bios: ['neogeo.zip'],
   *   retroarchConfig: {
   *     rewind_enable: true,
   *     savestate_thumbnail_enable: true,
   *   }
   *   runEmulatorManually: false,
   *   resolveCoreJs(core) {
   *     return `https://example.com/core/${core}_libretro.js`
   *   },
   *   resolveCoreWasm(core) {
   *     return `https://example.com/core/${core}_libretro.wasm`
   *   },
   *   resolveRom(file) {
   *     return `https://example.com/roms/${file}`
   *   },
   *   resolveBios(bios) {
   *     return `https://example.com/system/${bios}`
   *   },
   * })
   * ```
   */
  static async launch(options: WasmEmulatorLaunchOptions) {
    const instance = new WasmEmulator(options)
    await instance.load()
    return instance
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for Sega Genesis / Megadrive emulation.
   *
   * It will use genesis_plus_gx as the default core for emulation.
   */
  static async megadrive(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('megadrive', options)
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for NES emulation.
   *
   * It will use fceumm as the default core for emulation.
   */
  static async nes(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('nes', options)
  }

  static async prepare(options: WasmEmulatorLaunchOptions) {
    const instance = new WasmEmulator({ ...options, runEmulatorManually: true })
    await instance.load()
    return instance
  }

  /**
   * Reset the global configuation set by `WasmEmulator.configure` to default.
   */
  static resetToDefault() {
    resetGlobalOptions()
  }

  /**
   * A shortcut method for WasmEmulator.launch method, with some additional default options for SNES emulation.
   *
   * It will use snes9x as the default core for emulation.
   */
  static async snes(options: WasmEmulatorLaunchRomOptions) {
    return await WasmEmulator.launchSystem('snes', options)
  }

  private static async launchSystem(system: string, options: WasmEmulatorLaunchRomOptions) {
    const optionsResult = await getResult(options as any)
    const launchOptions = isResolvableFileInput(optionsResult) ? { rom: optionsResult } : optionsResult
    return await WasmEmulator.launch({ ...launchOptions, core: systemCoreMap[system] })
  }

  /**
   * Exit the current running game and the emulator. Remove the canvas element used by the emulator if needed.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.exit()
   * ```
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * // the canvas element will not be removed
   * emulator.exit({ removeCanvas: false })
   * ```
   */
  exit({ removeCanvas = true }: { removeCanvas?: boolean } = {}) {
    this.getEmulator().exit()
    if (removeCanvas) {
      this.getCanvas().remove()
    }
  }

  /**
   * Get the canvas DOM element that the current emulator is using.
   */
  getCanvas() {
    return this.getEmulatorOptions().element
  }

  /**
   * Get the Emscripten object exposed by RetroArch.
   */
  getEmscripten(): any {
    const emulator = this.getEmulator()
    return emulator.getEmscripten()
  }

  /**
   * Get the Emscripten AL object exposed by RetroArch.
   */
  getEmscriptenAL() {
    const emulator = this.getEmulator()
    return emulator.getEmscripten().AL
  }

  /**
   * Get the Emscripten FS object of the current running emulator.
   */
  getEmscriptenFS() {
    const emulator = this.getEmulator()
    const emscripten = emulator.getEmscripten()
    return emscripten.Module.FS
  }

  /**
   * Get the Emscripten Module object of the current running emulator.
   */
  getEmscriptenModule() {
    const emulator = this.getEmulator()
    const emscripten = emulator.getEmscripten()
    return emscripten.Module
  }

  getEmulator() {
    const { emulator } = this
    if (!emulator) {
      throw new Error('emulator is not ready')
    }
    return emulator
  }

  getEmulatorOptions() {
    if (!this.emulatorOptions) {
      throw new Error('emulator options are not ready')
    }
    return this.emulatorOptions
  }

  getOptions() {
    return this.options
  }

  /**
   * Get the status of current emulation.
   *
   * @returns One of 'initial' | 'paused' | 'running' | 'terminated'
   * @example
   * ```js
   * const emulator = await WasmEmulator.prepare('flappybird.nes')
   * console.log(emulator.getStatus()) // 'initial'
   *
   * await emulator.launch()
   * console.log(emulator.getStatus()) // 'running'
   *
   * await emulator.pause()
   * console.log(emulator.getStatus()) // 'paused'
   *
   * emulator.exit()
   * console.log(emulator.getStatus()) // 'terminated'
   * ```
   */
  getStatus() {
    return this.getEmulator().getStatus()
  }

  /**
   * Launch the emulator, if it's not launched, because of the launch option `runEmulatorManually` being set to `true`.
   * @deprecated Use the `start` method instead.
   */
  async launchEmulator() {
    return await this.start()
  }

  /**
   * Load a state for the current running emulator and game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * // save the state
   * const { state } = await emulator.saveState()
   *
   * // load the state
   * await emulator.loadState(state)
   * ```
   */
  async loadState(state: ResolvableFileInput) {
    const resolvable = await ResolvableFile.create(state)
    await this.getEmulator().loadState(resolvable)
  }

  /**
   * Pause the current running game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.pause()
   * ```
   */
  pause() {
    this.getEmulator().pause()
  }

  /**
   * Press a button and then release it programmatically. Analog Joysticks are not supported by now.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * await emulator.press('start')
   * ```
   */
  async press(options: { button: string; player?: number; time?: number } | string) {
    const emulator = this.getEmulator()
    await (typeof options === 'string'
      ? emulator.press(options)
      : emulator.press(options.button, options.player, options.time))
  }

  /**
   * Press a button programmatically. Analog Joysticks are not supported by now.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.pressDown('start')
   * ```
   */
  pressDown(options: { button: string; player?: number } | string) {
    const emulator = this.getEmulator()
    if (typeof options === 'string') {
      return emulator.pressDown(options)
    }
    return emulator.pressDown(options.button, options.player)
  }

  /**
   * Release it programmatically. Analog Joysticks are not supported by now.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.pressUp('start')
   * ```
   */
  pressUp(options: { button: string; player?: number } | string) {
    const emulator = this.getEmulator()
    if (typeof options === 'string') {
      return emulator.pressUp(options)
    }
    return emulator.pressUp(options.button, options.player)
  }

  /**
   * Resize the canvas element of the emulator.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.resize({ width: 1000, height: 800 })
   * ```
   */
  resize(size: { height: number; width: number }) {
    return this.getEmulator().resize(size)
  }

  /**
   * Restart the current running game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.restart()
   * ```
   */
  restart() {
    this.getEmulator().restart()
  }

  /**
   * Resume the current running game, if it has been paused by `pause`.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.pause()
   * await new Promise(resolve => setTimeout(resolve, 1000))
   * emulator.resume()
   * ```
   */
  resume() {
    this.getEmulator().resume()
  }

  /**
   * Save the SRAM of the current running game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * const sram = await emulator.saveSRAM()
   * ```
   */
  async saveSRAM() {
    const emulator = this.getEmulator()
    return await emulator.saveSRAM()
  }

  /**
   * Save the state of the current running game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * // save the state
   * const { state } = await emulator.saveState()
   *
   * // load the state
   * await emulator.loadState(state)
   * ```
   * @returns
   * A Promise of the state of the current running game.
   *
   * Its type is like `Promise<{ state: Blob, thumbnail: Blob | undefined }>`.
   *
   * If RetroArch is launched with the option `savestate_thumbnail_enable` set to `true`, which is the default value, then the `thumbnail` will be a `Blob`. Otherwise the `thumbnail` will be `undefined`.
   */
  async saveState() {
    return await this.getEmulator().saveState()
  }

  /**
   * Take a screenshot for the current running game.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * const blob = await emulator.screenshot()
   * ```
   */
  async screenshot() {
    const emulator = this.getEmulator()
    return await emulator.screenshot()
  }

  /**
   * Send a command to RetroArch.
   * The commands are listed here: https://docs.libretro.com/development/retroarch/network-control-interface/#commands .
   * But not all of them are supported inside a browser.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.sendCommand('FAST_FORWARD')
   * ```
   */
  sendCommand(command: RetroArchCommand) {
    const emulator = this.getEmulator()
    return emulator.sendCommand(command)
  }

  /**
   * Advance the emulator by exactly one frame.
   * The emulator must be paused for this to work.
   * This is useful for frame-perfect netplay synchronization.
   *
   * @example
   * ```js
   * const emulator = await WasmEmulator.nes('flappybird.nes')
   *
   * emulator.pause()
   * emulator.frameAdvance() // Execute one frame
   * ```
   */
  frameAdvance() {
    this.sendCommand('FRAMEADVANCE')
  }

  /**
   * Get a fast checksum of WASM memory without saveState().
   * Useful for netplay desync detection without blocking the main thread.
   */
  getMemoryChecksum(): string {
    return this.getEmulator().getMemoryChecksum()
  }

  /**
   * Check if the emulator is currently paused.
   */
  isPaused(): boolean {
    return this.getStatus() === 'paused'
  }

  /**
   * Start the emulator if it's not started because of the instance is returned by `WasmEmulator.prepare` rather than `WasmEmulator.launch`, or the option `runEmulatorManually` for `WasmEmulator.launch` being set to `true`.
   */
  async start() {
    return await this.getEmulator().launch()
  }

  /**
   * Load options and then launch corresponding emulator if should
   */
  private async load(): Promise<void> {
    this.emulatorOptions = await EmulatorOptions.create(this.options)
    checkIsAborted(this.options.signal)

    if (this.options.setupEmulatorManually) {
      return
    }

    await this.setupEmulator()

    if (this.options.runEmulatorManually) {
      return
    }

    await this.start()
  }

  private async setupEmulator() {
    const emulatorOptions = this.getEmulatorOptions()
    this.emulator = new Emulator(emulatorOptions)
    this.emulator
      .on('onLaunch', () => this.options.onLaunch?.(this))
      .on('beforeLaunch', () => this.options.beforeLaunch?.(this))
    await this.emulator.setup()
  }
}
