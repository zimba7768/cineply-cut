# Cineply Cut architecture

Cineply Cut is an Electron app with a React + TypeScript renderer, built with electron-vite.

```
src/
  shared/          types.ts (project data model), ipc.ts (preload API contract)
  main/            Electron main process
    index.ts       window, menu, cineply-media:// protocol, core IPC (dialogs, fs, settings, download)
    ffmpeg.ts      bundled ffmpeg/ffprobe: probe, transcode-to-playable, thumbnails, generic run with progress
    higgsfield.ts  Higgsfield API client (IPC channels 'hf:*')
    audio.ts       audio processing jobs, e.g. noise reduction (IPC 'audio:*')
    export.ts      export helpers (IPC 'export:*')
  preload/         exposes window.cineply (see shared/ipc.ts)
  renderer/src/
    store/         zustand stores: project (undoable), playback (transport), ui (selection, tool, jobs, modals)
    engine/        compositor.ts, frames.ts (FrameProvider), playback.ts, transitions/, effects/, titles/
    audio/         Web Audio engine (playback + offline mix), effects, waveforms, voiceover
    components/    UI panels, timeline, inspector, modals, ui/controls.tsx (shared controls)
    lib/           ids, time, params (ParamDef), dnd (drag payloads), importMedia, projectIO
    hooks/         useAppCommands (menu + keyboard shortcuts)
```

## Rules of the road

1. **The project is plain JSON** (`shared/types.ts`). All edits go through `useProject.getState().mutate(label, draft => …)`, which uses immer and records undo history. Pass `{ coalesce: 'some-key' }` for continuous slider drags so they become a single undo step. Non-undoable bookkeeping, such as media transcode status, uses `mutateSilently`.
2. **Times are seconds.** Clip `start`/`duration` are timeline seconds, `in` is the source offset, and `speed` scales source time. `sourceTimeAt(clip, t)` converts timeline time to source time.
3. **Track order.** Video tracks come first, listed top-most first (V3, V2, V1), then the audio tracks (A1, A2…). The compositor draws video bottom-up. Video tracks are silent: a video file with sound becomes a video clip plus a *linked* audio clip (same `linkId`) on an audio track.
4. **Preview and export share the compositor.** `engine/compositor.ts#renderFrame(ctx, project, t, frameProvider, {scale})` is the only place frames are composed. Preview passes a `FrameProvider` backed by `<video>` elements; export passes a frame-accurate decoder.
5. **The audio engine is the master clock.** `audio/engine.ts` plays the mix with Web Audio and reports `clockTime()`, and the picture follows it. The same graph-building code renders the offline mix for export, so what you hear is what you export.
6. **Registries.** Transitions (`engine/transitions`), video effects (`engine/effects`), title templates (`engine/titles`) and audio effects (`audio/effects`) are arrays of definitions. Each carries `ParamDef[]` so inspectors render its controls generically with `ParamControls`.
7. **Transitions** attach to clip edges (`transitionIn`/`transitionOut`). See the doc comment on `TransitionSpec` in `shared/types.ts` for the exact timing rules.
8. **Drag and drop** between panels and the timeline uses the payloads in `lib/dnd.ts`.
9. **Local files** are loaded in the renderer through `window.cineply.mediaUrl(path)`. This is the `cineply-media://` protocol, which supports HTTP Range requests so video seeking works. Files Chromium can't decode (HEVC, ProRes, etc.) are transcoded to H.264 on import (`media.playbackPath`).
10. **Secrets** (Higgsfield API keys) are stored with `settings.setSecret`, which uses OS-level encryption via Electron safeStorage. They never go into project files.
11. **Background work** shows in the jobs list: `useUi.getState().upsertJob({ id, label, progress, status, cancel })`.
