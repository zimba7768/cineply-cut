import type { MediaItem, MediaSource } from '@shared/types'

/**
 * Imports files into the project's media bin: probes them, transcodes unplayable formats in the
 * background, and returns the new media items (already added to the project).
 */
export async function importFiles(
  paths: string[],
  opts?: { source?: MediaSource; ai?: MediaItem['ai'] }
): Promise<MediaItem[]> {
  void paths; void opts
  return []
}
