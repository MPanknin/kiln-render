/** Channel naming for the viewer UI, from OMERO display metadata when the dataset has it. */

/** Display name for channel `index`: its OMERO label when non-blank, else "Channel <index>". */
export function channelDisplayName(label: string | undefined, index: number): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed : `Channel ${index}`;
}
