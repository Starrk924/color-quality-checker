figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColorError {
  nodeId: string;
  nodeName: string;
  property: 'Fill' | 'Stroke';
  errorType: 'Style' | 'Raw value';
  value: string;
  path: string[];
}

type PluginMessage =
  | { type: 'check' }
  | { type: 'focus'; nodeId: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const ch = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function resolveStyleName(styleId: string): string {
  try {
    const style = figma.getStyleById(styleId);
    return style ? style.name : styleId;
  } catch {
    return styleId;
  }
}

// ─── Audit logic ──────────────────────────────────────────────────────────────

/**
 * Audits a paints array (fills or strokes) against variable usage rules.
 *
 * Rules:
 *   - If a paint style ID is set → Error: Style (styles are not variables)
 *   - If a solid paint has no variable binding → Error: Raw value
 *   - Gradient / image / video paints are skipped (not color-variable territory)
 */
function auditPaints(
  node: SceneNode,
  paints: ReadonlyArray<Paint>,
  styleId: string | symbol | undefined,
  property: 'Fill' | 'Stroke',
  errors: ColorError[],
  path: string[]
): void {
  // A style reference on any paint counts as an error — styles ≠ variables.
  if (typeof styleId === 'string' && styleId.length > 0) {
    errors.push({
      nodeId: node.id,
      nodeName: node.name,
      property,
      errorType: 'Style',
      value: resolveStyleName(styleId),
      path,
    });
    // No need to dig into individual paints; the style drives them all.
    return;
  }

  for (const paint of paints) {
    if (paint.type !== 'SOLID') continue;

    const solid = paint as SolidPaint;
    if (!solid.boundVariables?.color) {
      errors.push({
        nodeId: node.id,
        nodeName: node.name,
        property,
        errorType: 'Raw value',
        value: rgbToHex(solid.color.r, solid.color.g, solid.color.b),
        path,
      });
    }
  }
}

function auditNode(node: SceneNode, errors: ColorError[], path: string[]): void {
  // ── Fills ──
  if ('fills' in node) {
    const n = node as SceneNode & {
      fills: ReadonlyArray<Paint> | typeof figma.mixed;
      fillStyleId?: string | typeof figma.mixed;
    };
    const fills = n.fills;
    if (fills !== figma.mixed && fills.length > 0) {
      const sid = n.fillStyleId;
      auditPaints(node, fills, sid as string | symbol | undefined, 'Fill', errors, path);
    }
  }

  // ── Strokes ──
  if ('strokes' in node) {
    const n = node as SceneNode & {
      strokes: ReadonlyArray<Paint>;
      strokeStyleId?: string | typeof figma.mixed;
    };
    const strokes = n.strokes;
    if (strokes.length > 0) {
      const sid = n.strokeStyleId;
      auditPaints(node, strokes, sid as string | symbol | undefined, 'Stroke', errors, path);
    }
  }
}

/**
 * Recursively walks the node tree, including FRAME, GROUP, COMPONENT,
 * COMPONENT_SET, INSTANCE, and any other container with children.
 * For INSTANCE nodes, Figma already exposes overriding children via .children.
 */
function traverse(node: SceneNode, errors: ColorError[], path: string[] = []): void {
  const currentPath = [...path, node.name];
  auditNode(node, errors, currentPath);

  if ('children' in node) {
    const parent = node as SceneNode & { children: ReadonlyArray<SceneNode> };
    for (const child of parent.children) {
      traverse(child, errors, currentPath);
    }
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = (msg: PluginMessage) => {
  // ── Check ──
  if (msg.type === 'check') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Nothing is selected. Please select a frame to audit.',
      });
      return;
    }

    // Prefer the first FRAME in selection; accept COMPONENT/COMPONENT_SET
    // as fallback; finally fall back to whatever is selected first.
    const target =
      selection.find((n) => n.type === 'FRAME') ??
      selection.find((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ??
      selection[0];

    if (!target) {
      figma.ui.postMessage({
        type: 'error',
        message: 'No frame found in selection. Please select a frame.',
      });
      return;
    }

    const errors: ColorError[] = [];
    traverse(target, errors);

    figma.ui.postMessage(
      errors.length === 0
        ? { type: 'success' }
        : { type: 'results', errors }
    );
    return;
  }

  // ── Focus ──
  if (msg.type === 'focus') {
    const node = figma.getNodeById(msg.nodeId);
    if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
  }
};
