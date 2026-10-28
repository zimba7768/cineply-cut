/** Fonts offered in the title editor: Windows system fonts with sensible generic fallbacks. */
export interface FontChoice {
  label: string
  value: string // CSS font-family list stored in TitleTextLayer.fontFamily
}

const sans = (name: string): FontChoice => ({ label: name, value: `${name}, sans-serif` })
const serif = (name: string): FontChoice => ({ label: name, value: `${name}, serif` })
const mono = (name: string): FontChoice => ({ label: name, value: `${name}, monospace` })
const script = (name: string): FontChoice => ({ label: name, value: `${name}, cursive` })

export const SYSTEM_FONTS: FontChoice[] = [
  { label: 'Inter / Segoe UI', value: 'Inter, Segoe UI, sans-serif' },
  sans('Segoe UI'),
  sans('Segoe UI Light'),
  sans('Segoe UI Semibold'),
  sans('Segoe UI Black'),
  sans('Arial'),
  sans('Arial Black'),
  sans('Bahnschrift'),
  sans('Calibri'),
  sans('Candara'),
  sans('Corbel'),
  sans('Franklin Gothic Medium'),
  sans('Impact'),
  sans('Tahoma'),
  sans('Trebuchet MS'),
  sans('Verdana'),
  serif('Georgia'),
  serif('Times New Roman'),
  serif('Cambria'),
  serif('Constantia'),
  serif('Palatino Linotype'),
  serif('Sitka Text'),
  mono('Consolas'),
  mono('Cascadia Code'),
  mono('Cascadia Mono'),
  mono('Courier New'),
  mono('Lucida Console'),
  script('Comic Sans MS'),
  script('Segoe Print'),
  script('Segoe Script'),
  script('Ink Free'),
  script('Gabriola')
]

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'ui-sans-serif', 'ui-serif', 'ui-monospace'])

/** Quotes each family name of a font-family list so names with spaces or digits parse reliably. */
export function cssFontFamily(family: string): string {
  const parts = family
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (GENERIC.has(f.toLowerCase()) || /^["'].*["']$/.test(f) ? f : `"${f.replace(/"/g, '')}"`))
  return parts.length ? parts.join(', ') : 'sans-serif'
}

/** First family name of a font-family list, for display. */
export function primaryFontName(family: string): string {
  return family.split(',')[0].trim().replace(/^["']|["']$/g, '')
}
