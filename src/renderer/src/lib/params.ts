/** Describes one user-editable parameter of a transition, effect, etc. Inspectors render these generically. */
export interface ParamDef {
  key: string
  label: string
  type: 'number' | 'color' | 'select' | 'boolean' | 'text'
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  /** Slider response; 'log' suits frequencies (min must be > 0). */
  scale?: 'linear' | 'log'
  options?: { value: string; label: string }[]
}

export function defaultParams(defs: ParamDef[]): Record<string, number | string | boolean> {
  return Object.fromEntries(defs.map((d) => [d.key, d.default]))
}
