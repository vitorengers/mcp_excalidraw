/**
 * What the clipboard is offering an issue block, and whether the block may take it.
 *
 * Attaching reference images was picker-only, and a file picker is exactly the control a
 * screenshot cannot reach: `Win+Shift+S` and `PrtScn` produce a bitmap with no path on
 * disk, so the flow was paste into another application, save a file, then find that file
 * in the picker. Everything below the picker is already source-agnostic — an image read
 * off a `paste` event *is* a `File`, typed `image/png` — so what was missing was only the
 * decision made here.
 *
 * It is pure, and it lives outside the panel, because the panel needs a browser to be
 * checked and this does not. Three small decisions, every one of them wrong in a way that
 * compiles: which of the clipboard's contents is an image, whether the block showing may
 * take one, and what to call a file that arrived without a name.
 *
 * Typed structurally rather than against the DOM: the server build has no `lib.dom`, and
 * the browser's own `DataTransfer`, `FileList` and `File` satisfy these shapes as they
 * are.
 */

/** Enough of a `File` to decide about it. */
export interface PastedFile {
  /** `image.png` for a screenshot in Chrome, and sometimes nothing at all. */
  name?: string;
  type?: string;
  size?: number;
}

/** Enough of a `DataTransferItem`. */
export interface PastedItem<F> {
  kind?: string;
  type?: string;
  getAsFile: () => F | null;
}

/** Enough of a `DataTransfer`. */
export interface PastedClipboard<F> {
  files?: ArrayLike<F> | null;
  items?: ArrayLike<PastedItem<F>> | null;
}

function isImage(file: PastedFile | null | undefined): boolean {
  return Boolean(file && typeof file.type === 'string' && file.type.startsWith('image/'));
}

/**
 * The images on a clipboard, and nothing else.
 *
 * `files` first, `items` only when it yielded none. Chrome puts the same screenshot on
 * both, so reading the two together would attach one image twice and draw two identical
 * thumbnails; and a browser that fills only `items` still has to work, which is why the
 * fallback exists at all rather than the simpler one-list read.
 */
export function clipboardImages<F extends PastedFile>(
  data: PastedClipboard<F> | null | undefined
): F[] {
  if (!data) return [];

  const fromFiles = Array.from(data.files ?? []).filter(isImage);
  if (fromFiles.length) return fromFiles;

  return Array.from(data.items ?? [])
    .map((item) => (typeof item?.getAsFile === 'function' ? item.getAsFile() : null))
    .filter((file): file is F => isImage(file));
}

/** Just enough of an issue block to decide whether it takes one. */
export interface PasteTarget {
  state?: string | null;
}

/**
 * Whether the panel takes a paste for the block it is showing.
 *
 * The same condition that puts **Attach reference images** on screen, written once so the
 * two cannot drift: images are material for the investigation, so a block whose issue
 * already exists — a mirrored card included, which is `created` by construction — or one
 * whose run is in flight has nothing left for a screenshot to inform. The failure worth
 * naming is either half of that drifting: a paste that silently does nothing, or one that
 * attaches to a block whose issue was written days ago.
 */
export function panelTakesPaste(issue: PasteTarget | null | undefined): boolean {
  if (!issue) return false;
  return issue.state !== 'created' && issue.state !== 'running';
}

/** Enough of an element to tell whether it is being typed into. */
export interface PasteEventTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Whether the paste is landing in something being typed into.
 *
 * The panel claims a paste at `document`, before anything else sees it, so it has to give
 * this case back: Excalidraw's own text editor, the observation box and any other field
 * keep their paste whether or not the block behind them would have taken an image.
 */
export function isWritableTarget(target: PasteEventTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/** What an unnamed file is called in a message to the reader. */
const UNNAMED = 'The pasted image';

/**
 * What to call a file when telling the reader something about it.
 *
 * The too-large message was built from the name alone, which was fine while every image
 * came from a picker and had one. A pasted screenshot is `image.png` at best and unnamed
 * at worst, and unnamed read as " is larger than 10 MB." — a sentence with a hole exactly
 * where the pasting starts.
 */
export function referenceImageName(file: PastedFile | null | undefined): string {
  const name = typeof file?.name === 'string' ? file.name.trim() : '';
  return name || UNNAMED;
}
