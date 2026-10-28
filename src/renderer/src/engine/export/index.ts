export { runExport, type ExportProgress, type ExportResult, type EncoderUsed } from './pipeline'
export { startExport, cancelExport, useExport, type ExportRun } from './state'
export { DecoderFrameProvider } from './frameProvider'
export { encodeWav, encodePcm, wavHeader, writeWavStream } from './wav'
export * from './settings'

import { runExport } from './pipeline'
import { startExport, cancelExport, useExport } from './state'
import { DecoderFrameProvider } from './frameProvider'

// Dev-only hook so the pipeline can be driven from DevTools / CDP test scripts.
if (import.meta.env.DEV) {
  Object.assign(window, { __cineplyExport: { runExport, startExport, cancelExport, useExport, DecoderFrameProvider } })
}
