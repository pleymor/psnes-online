/**
 * RetroArch configuration type.
 *
 * Simplified from original 3000+ lines of type definitions.
 * Since these are passed as config strings to RetroArch WASM,
 * we only need basic type checking - all values are optional
 * and will be converted to RetroArch's internal format.
 */
export type RetroArchConfig = Record<string, string | number | boolean | undefined>
