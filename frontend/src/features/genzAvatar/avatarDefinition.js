// Zee — The Gen Z Guide · original avatar schema (clean-room, Gen Z Digital Store).
// Geometry + palette constants for the hand-drawn SVG. All original; not derived from any external
// avatar definition. Units are viewBox units (the SVG is a square canvas scaled to any pixel size).

export const AVATAR_NAME = 'Zee';
export const VIEWBOX = 120; // square canvas: 0 0 120 120

// Brand palette (matches the Gen Z Digital Store tokens).
export const PALETTE = {
  navy: '#071B33',
  blue: '#2563EB',
  cyan: '#06B6D4',
  teal: '#0E9F9A',
  face: '#ECF5FF',
  faceEdge: '#CFE6FB',
  white: '#FFFFFF',
  success: '#16A34A',
  warning: '#D97706',
  error: '#DC2626',
};

// Independently controllable SVG layers (every DOM id/class is `genz-avatar-` prefixed in the JSX).
export const LAYER_IDS = Object.freeze([
  'root', 'head', 'face', 'headset',
  'eye-well-left', 'eye-well-right', 'pupil-left', 'pupil-right',
  'brow-left', 'brow-right', 'mouth', 'body', 'badge', 'highlight',
]);

// Pupils may track the pointer only within this small, safe range (viewBox units) so the eyes never
// look detached or cartoonishly wide.
export const PUPIL_MAX_OFFSET = 3.2;

// Accent → palette key per status badge semantics.
export const BADGE_ACCENT = { success: 'success', warning: 'warning', error: 'error', none: 'cyan' };
