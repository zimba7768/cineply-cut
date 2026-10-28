import type { ParamDef } from '@/lib/params'
import type { Params } from './util'

/** ParamDef shorthands and typed param readers shared by the effect and transition registries. */

export const numberParam = (key: string, label: string, def: number, min: number, max: number, step = 0.01, unit?: string): ParamDef => ({
  key, label, type: 'number', default: def, min, max, step, unit
})
export const selectParam = (key: string, label: string, def: string, options: [string, string][]): ParamDef => ({
  key, label, type: 'select', default: def, options: options.map(([value, l]) => ({ value, label: l }))
})
export const colorParam = (key: string, label: string, def: string): ParamDef => ({ key, label, type: 'color', default: def })
export const boolParam = (key: string, label: string, def: boolean): ParamDef => ({ key, label, type: 'boolean', default: def })

export const num = (params: Params, key: string): number => Number(params[key]) || 0
export const str = (params: Params, key: string): string => String(params[key] ?? '')
export const bool = (params: Params, key: string): boolean => params[key] === true || params[key] === 'true'

/** Scale factor for pixel-valued params, which are specified relative to a 1080-pixel-high frame. */
export const unit = (h: number): number => h / 1080
