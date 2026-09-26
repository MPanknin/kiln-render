/** Channel naming for the viewer UI, from OMERO display metadata when the dataset has it. */

/** Display name for channel `index`: its OMERO label when non-blank, else "Channel <index>". */
export function channelDisplayName(label: string | undefined, index: number): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed : `Channel ${index}`;
}

/** Note shown when the dataset has more channels than the renderer displays; null when all are shown. */
export function hiddenChannelsNote(shown: number, total: number): string | null {
  return total > shown ? `Showing the first ${shown} of ${total} channels` : null;
}
