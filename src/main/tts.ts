// Text-to-speech with the voices built into Windows (System.Speech, free and offline).
// IPC: 'audio:tts:voices' and 'audio:tts:speak'. Registered from registerHiggsfieldIpc.
//
// The PowerShell script is a constant. User text travels through a JSON job file whose path is
// passed in an environment variable, so nothing the user typed ever reaches a command line.

import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { mediaDir } from './index'

export interface TtsVoice {
  name: string
  culture: string
  gender: string
  age: string
}

export interface TtsSpeakRequest {
  text: string
  voice?: string
  rate?: number // -10..10
  volume?: number // 0..100
}

const MAX_TEXT = 20_000

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Speech
  $job = Get-Content -LiteralPath $env:CINEPLY_TTS_JOB -Raw -Encoding UTF8 | ConvertFrom-Json
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    if ($job.action -eq 'voices') {
      $list = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
        $v = $_.VoiceInfo
        [pscustomobject]@{ name = $v.Name; culture = $v.Culture.Name; gender = [string]$v.Gender; age = [string]$v.Age }
      })
      ConvertTo-Json -InputObject $list -Compress
    } else {
      if ($job.voice) { $s.SelectVoice([string]$job.voice) }
      $s.Rate = [int]$job.rate
      $s.Volume = [int]$job.volume
      $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $s.SetOutputToWaveFile([string]$job.out, $fmt)
      $s.Speak([string]$job.text)
      $s.SetOutputToNull()
      '{"ok":true}'
    }
  } finally {
    $s.Dispose()
  }
} catch {
  ConvertTo-Json -InputObject @{ error = $_.Exception.Message } -Compress
  exit 1
}
`

const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

async function runScript(job: Record<string, unknown>): Promise<string> {
  const dir = join(app.getPath('temp'), 'cineply-cut', 'tts')
  await fsp.mkdir(dir, { recursive: true })
  const jobFile = join(dir, `${randomUUID()}.json`)
  await fsp.writeFile(jobFile, JSON.stringify(job), 'utf8')
  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT],
        { env: { ...process.env, CINEPLY_TTS_JOB: jobFile }, windowsHide: true }
      )
      let stdout = ''
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      const timer = setTimeout(() => proc.kill(), 120_000)
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`Couldn’t start PowerShell: ${e.message}`))
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        const out = stdout.trim()
        if (code === 0) return resolve(out)
        let message = `Speech synthesis failed (exit ${code}).`
        try {
          message = JSON.parse(out.split('\n').pop() ?? '').error ?? message
        } catch {
          // keep the generic message
        }
        reject(new Error(message))
      })
    })
  } finally {
    await fsp.rm(jobFile, { force: true })
  }
}

let voiceCache: TtsVoice[] | null = null

async function listVoices(): Promise<TtsVoice[]> {
  if (process.platform !== 'win32') return []
  if (!voiceCache) {
    const parsed = JSON.parse((await runScript({ action: 'voices' })) || '[]')
    voiceCache = Array.isArray(parsed) ? parsed : [parsed]
  }
  return voiceCache
}

function fileName(text: string): string {
  const words = text.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 6).join('-').toLowerCase()
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `voice_${words || 'speech'}_${ts}`
}

async function speak(req: TtsSpeakRequest): Promise<{ path: string }> {
  if (process.platform !== 'win32') throw new Error('Built-in voices are only available on Windows.')
  const text = String(req?.text ?? '').trim()
  if (!text) throw new Error('Type something to say first.')
  if (text.length > MAX_TEXT) throw new Error(`That text is too long (max ${MAX_TEXT.toLocaleString()} characters).`)
  const voices = await listVoices()
  const voice = req.voice && voices.some((v) => v.name === req.voice) ? req.voice : ''
  const dir = join(await mediaDir(), 'AI')
  await fsp.mkdir(dir, { recursive: true })
  const base = fileName(text)
  let out = join(dir, `${base}.wav`)
  for (let n = 2; existsSync(out); n++) out = join(dir, `${base} (${n}).wav`)
  await runScript({
    action: 'speak',
    text,
    voice,
    rate: Math.round(Math.min(10, Math.max(-10, Number(req.rate) || 0))),
    volume: Math.round(Math.min(100, Math.max(0, req.volume ?? 100))),
    out
  })
  return { path: out }
}

export function registerTtsIpc(): void {
  ipcMain.handle('audio:tts:voices', () => listVoices())
  ipcMain.handle('audio:tts:speak', (_e, req: TtsSpeakRequest) => speak(req))
}
