# Cineply Cut

**A free, open-source video editor for Windows.** It has a multi-track timeline, 33 transitions, animated titles, full audio editing, and built-in [Higgsfield](https://higgsfield.ai) AI generation.

Cineply Cut covers the parts of a Premiere-style editor that most projects need, and leaves out the rest.

## Features

### Editing
- Unlimited video and audio tracks, with lock, hide/mute, solo, and resizable heights
- Select, razor, and ripple tools; trim handles; snapping; marquee selection; linked video and audio clips
- Ripple delete, copy/paste, duplicate, nudge, clip speed, markers, and in/out points
- Undo/redo for everything, project save/open (`.cineply`), and autosave with crash recovery
- Drag files in from Explorer. Formats Chromium can't play, such as HEVC or ProRes, are converted automatically.

### Video
- **33 transitions:**
  - Dissolve: cross, additive, film, blur, and luma fade; dip to black/white
  - Wipe: wipe, clock wipe, barn door, blinds, checkerboard, ink spread
  - Iris shapes
  - Push, slide, split, and whip pan
  - Zoom: zoom in, zoom out, cross zoom, spin
  - 3D: flip, cube, and page turn
  - Glitch, light leak, pixelate, ripple
- **19 effects:**
  - Color: black & white, sepia, tint, invert, posterize, color balance
  - Blur and sharpen
  - Stylize: vignette, film grain, old film, glow, RGB split, pixelate, mirror, wave warp, letterbox
  - Keying: chroma key (green screen)
- Motion and opacity: position, scale, rotation, crop, opacity, blend modes, and color adjustments, all keyframeable

### Titles
- 16 animated templates, including lower thirds, credits, a news banner, quote, neon, a social hook, and a typewriter
- Multiple text and shape layers per title, with 32 Windows fonts, stroke, shadow, background boxes, gradients, and image backgrounds
- 12 in/out animations: fade, slide, zoom, pop, typewriter, blur, wipe, and per-letter fade

### Audio
- Waveforms, per-clip gain and pan, fades, volume keyframes, and automatic crossfades
- A mixer with per-track faders, pan, mute/solo, live meters, and effect racks on clips or tracks
- **13 effects:** parametric EQ, compressor, limiter, reverb, delay, noise gate, de-esser, bass boost, stereo width, telephone/radio, and filters
- **Noise reduction:** removes background noise and 50/60 Hz hum
- Loudness **normalize** to a target peak or LUFS (-14, -16, or -23)
- **Voiceover recording** from your microphone straight onto a track

### AI (Higgsfield)
- **Text → Video**, **Image → Video** (from a still or the current frame), and **Text → Image**
- **AI soundtracks** from Higgsfield video models that generate sound
- **Voice:** text-to-speech using built-in Windows voices. Higgsfield's API doesn't offer TTS.
- Results download into your media bin, ready to drag onto the timeline. A cost estimate is shown before each generation.

### Export
- MP4 (H.264 + AAC) at 1080p, 4K, vertical 9:16, or the sequence size
- Hardware-accelerated encoding through WebCodecs, with automatic fallback to FFmpeg x264
- Audio-only WAV or MP3

## Install

Download the latest installer from [Releases](https://github.com/zimba7768/cineply-cut/releases) and run `CineplyCut-Setup-x.y.z.exe`.

The installer isn't code-signed yet, so Windows SmartScreen may warn you. Choose **More info → Run anyway**.

## Connect Higgsfield

1. Create an API key at [console.higgsfield.ai](https://console.higgsfield.ai). Generations are billed to your Higgsfield balance.
2. In Cineply Cut, click **⚙ Settings**, paste your **Key ID** and **Key Secret**, and click **Test connection**.

Your keys are encrypted with Windows' secure storage and are only ever sent to `api.higgsfield.ai`. To try the AI workflow without spending credits, turn on **Mock mode** in Settings.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| J / K / L | Shuttle reverse / stop / forward (press again for faster) |
| ← / → | Previous / next frame |
| ↑ / ↓ | Previous / next edit point |
| Home / End | Go to start / end |
| V / C / B | Select / razor / ripple tool |
| Ctrl+K | Split at playhead |
| Delete / Shift+Delete | Delete / ripple delete |
| Ctrl+C / Ctrl+V / Ctrl+D | Copy / paste / duplicate |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| I / O | Set in / out point |
| M | Add marker |
| + / − / \\ | Zoom in / zoom out / zoom to fit |
| S | Toggle snapping |
| Ctrl+I / Ctrl+M / Ctrl+T | Import / export / new title |

Help → Keyboard Shortcuts in the app lists them all.

## Build from source

You need Node.js 24 or newer.

```bash
git clone https://github.com/zimba7768/cineply-cut.git
cd cineply-cut
npm install
npm run dev          # run with hot reload
npm run dist         # build the Windows installer into release/
```

FFmpeg is bundled through `ffmpeg-static`, so you don't need to install it.

## Architecture

Cineply Cut is built with Electron, React, TypeScript, and zustand. Preview and export share one compositor, so what you see is what you export. The Web Audio engine is the master clock.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 zimba7768 and Cineply Cut contributors
