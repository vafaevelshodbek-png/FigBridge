/**
 * Placing a rendered slide in the file: in Figma Slides as a real slide, elsewhere as a frame
 * on the canvas; and keeping the deck's speaker notes with it.
 */
import type { FontLoader } from "./fonts.js";

/** Key of a slide's speaker notes in its plugin data (readable by agents via node.get). */
export const NOTES_KEY = "figbridge.notes";

/**
 * Finish a frame rendered inside a new Figma Slides slide (render into the slide directly:
 * nodes moved into a slide later are shifted by the slide grid). When the deck has the
 * slide's size (1920 × 1080), the frame's content becomes the slide's own layers; otherwise
 * the frame is scaled to fit and centred, as PowerPoint shows a 4:3 deck on a 16:9 screen.
 */
export function fitIntoSlide(slide: SlideNode, frame: FrameNode): SlideNode {
  slide.name = frame.name;
  slide.fills = frame.fills;
  const scale = Math.min(slide.width / frame.width, slide.height / frame.height);
  if (Math.abs(scale - 1) < 0.001 && Math.abs(frame.height - slide.height) < 0.5) {
    for (const child of [...frame.children]) slide.appendChild(child);
    frame.remove();
    return slide;
  }
  frame.rescale(scale);
  frame.x = (slide.width - frame.width) / 2;
  frame.y = (slide.height - frame.height) / 2;
  frame.name = "Content";
  return slide;
}

/**
 * Keep speaker notes with the slide: as an annotation (shown in Dev Mode), in plugin data,
 * and — in Figma Slides, whose notes panel plugins cannot write — as a hidden text layer
 * named "Speaker notes" that the user can find and copy.
 */
export async function attachNotes(
  node: FrameNode | SlideNode,
  notes: string,
  fonts: FontLoader,
): Promise<void> {
  node.setPluginData(NOTES_KEY, notes);
  try {
    node.annotations = [{ label: notes }];
  } catch {
    // Annotations are not available in every editor; plugin data still has the notes.
  }
  if (node.type !== "SLIDE") return;
  const text = figma.createText();
  node.appendChild(text);
  text.fontName = await fonts.resolve({ family: "Inter", style: "Regular" });
  text.characters = notes;
  text.fontSize = 24;
  text.name = "Speaker notes";
  text.visible = false;
  text.locked = true;
  text.x = 40;
  text.y = 40;
  text.resize(Math.max(1, node.width - 80), text.height);
}
