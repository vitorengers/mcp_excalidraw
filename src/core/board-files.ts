/**
 * Which files a board is carrying, and how many of them it may carry.
 *
 * The canvas had half a file store for a long time. `POST /api/files` existed for the issue
 * block's reference-image picker, `GET /api/files` served what a board's elements point at,
 * and the seed read `scene.files` back — but the autosync sent elements alone, so a
 * screenshot pasted on a board produced an element whose `fileId` reached the store and bytes
 * that never left the browser. Every reload came back with a hole where the image was
 * (#343).
 *
 * Closing that needs one question answered in three places that cannot be allowed to disagree
 * — the frontend deciding what to upload, the server deciding what to serve, and the save
 * deciding what to write: **which file ids does this board's scene actually name?** So it is
 * answered once, here.
 *
 * Pure, and imported by the frontend as well as the server, so nothing in this file may reach
 * for `fs`, a logger or anything else with a platform underneath it. The types are structural
 * for the same reason: an Excalidraw `BinaryFileData` in the browser and a `ExcalidrawFile` in
 * the server satisfy them as they are, and neither build has to learn about the other's.
 *
 * ## The two figures
 *
 * A dataURL is base64, which is a third larger than the bytes it carries, and both ends of
 * this have a ceiling.
 *
 * `FILE_UPLOAD_LIMIT_BYTES` is the request one: `express.json({ limit: '10mb' })` refuses
 * anything larger, so an upload is split into requests that fit and an image that could never
 * fit in one is refused *to the reader* rather than posted into a 413. Nine rather than ten,
 * because the payload is a JSON envelope around the dataURL and not the dataURL alone.
 *
 * `BOARD_IMAGE_BUDGET_BYTES` is the save one, and it is the honest half of a decision with no
 * unbounded answer: a board of screenshots can outgrow any figure, and the saved scene is
 * rewritten on a one-second debounce, so what is written has to be bounded by something. The
 * figure is what the write costs, measured rather than argued: a board saved at this ceiling —
 * thirty megabytes of dataURL and four hundred other shapes — serialises and lands through the
 * temporary file and the rename in **60 to 100 ms**, which is a tenth of the debounce it has
 * to fit inside, and a board of a dozen 1.2 MB screenshots comes to about twenty and is well
 * under it. Past the line the board still works and still shows every image; what it loses is
 * the ones over it surviving the process, and both ends say so — a warning naming the count in
 * the log, and a sentence on the canvas where the reader is.
 */

/** Enough of a stored file to size it, save it and serve it. */
export interface BoardFile {
  id: string;
  dataURL: string;
  mimeType?: string;
  created?: number;
}

/** Enough of an element to see which file it names. */
export interface FileBearingElement {
  fileId?: unknown;
  customData?: unknown;
  isDeleted?: boolean;
}

/** What one `POST /api/files` may carry, under `express.json({ limit: '10mb' })`. */
export const FILE_UPLOAD_LIMIT_BYTES = 9 * 1024 * 1024;

/** What one board's saved scene may carry in images. */
export const BOARD_IMAGE_BUDGET_BYTES = 32 * 1024 * 1024;

/** A byte figure as a reader would write it, for the one message that has to say the cap. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The ids a block has attached. Anything that is not a list of ids reads as none. */
export function issueImageIds(customData: unknown): string[] {
  const value = (customData as Record<string, unknown> | null | undefined)?.issueImages;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/**
 * Every file id a board's elements name, in the order the elements name them.
 *
 * Two sources, because there are two ways an image gets onto a board and only one of them was
 * ever wired up: an image element's own `fileId`, and the ids an issue block has attached for
 * the agent to read. Deleted elements name nothing — a tombstone travels in the autosync and
 * is not saved, and re-uploading the file of a shape somebody deleted is work for a picture
 * that is gone.
 *
 * Ordered and deduplicated rather than a `Set` straight off, because the budget below spends
 * itself down this list and a save that kept a different half of the board's images on every
 * write would be worse than one that kept none.
 */
export function referencedFileIds(elements: Iterable<FileBearingElement>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const take = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };

  for (const element of elements) {
    if (element.isDeleted) continue;
    const fileId = element.fileId;
    if (typeof fileId === 'string' && fileId) take(fileId);
    for (const id of issueImageIds(element.customData)) take(id);
  }
  return ordered;
}

/** What one file costs whoever writes or posts it: the dataURL as it is serialised. */
export function fileBytes(file: BoardFile | null | undefined): number {
  return typeof file?.dataURL === 'string' ? file.dataURL.length : 0;
}

/**
 * As many of a board's files as fit in a budget, and the names of the ones that did not.
 *
 * First come, first kept: `referencedFileIds` is scene order, so the board keeps the same
 * images across saves instead of a different subset each time. A file nothing knows the bytes
 * of is neither kept nor reported as dropped — it is not there to save, which is a different
 * fact from being over the line.
 */
export function withinBudget(
  ids: Iterable<string>,
  lookup: (id: string) => BoardFile | undefined,
  budget: number
): { kept: BoardFile[]; dropped: string[]; bytes: number } {
  const kept: BoardFile[] = [];
  const dropped: string[] = [];
  let bytes = 0;

  for (const id of ids) {
    const file = lookup(id);
    if (!file || !fileBytes(file)) continue;
    const cost = fileBytes(file);
    if (bytes + cost > budget) { dropped.push(id); continue; }
    kept.push(file);
    bytes += cost;
  }
  return { kept, dropped, bytes };
}

/**
 * Files grouped into requests that will not be refused, and the ones no request could hold.
 *
 * A naive upload posts everything in one body, which is fine until a board has two screenshots
 * on it and the second `POST /api/files` comes back 413 with nothing said to anybody. A file
 * that is over the limit on its own cannot be split, so it is handed back separately: that is
 * the one case with something to tell the reader.
 */
export function uploadBatches(
  files: BoardFile[],
  limit: number = FILE_UPLOAD_LIMIT_BYTES
): { batches: BoardFile[][]; refused: BoardFile[] } {
  const batches: BoardFile[][] = [];
  const refused: BoardFile[] = [];
  let current: BoardFile[] = [];
  let bytes = 0;

  for (const file of files) {
    const cost = fileBytes(file);
    if (!cost) continue;
    if (cost > limit) { refused.push(file); continue; }
    if (bytes + cost > limit && current.length) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += cost;
  }
  if (current.length) batches.push(current);
  return { batches, refused };
}
