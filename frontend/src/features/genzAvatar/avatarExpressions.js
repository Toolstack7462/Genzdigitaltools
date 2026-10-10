// Zee — original expression parameters (pure data). Each expression sets eye openness, brow offset/
// tilt, a mouth shape key, and a brand accent. Consumed by the SVG layers; no external data used.

export const MOUTH_SHAPES = ['line', 'smile', 'small', 'talk', 'open', 'frown'];

const DATA = {
  //            eyeOpen  browY  browTilt  mouth     accent
  neutral:     { eyeOpen: 1.0,  browY: 0,  browTilt: 0,   mouth: 'line',  accent: 'blue' },
  friendly:    { eyeOpen: 1.0,  browY: -1, browTilt: -4,  mouth: 'smile', accent: 'cyan' },
  attentive:   { eyeOpen: 1.12, browY: -2, browTilt: -2,  mouth: 'line',  accent: 'cyan' },
  thinking:    { eyeOpen: 0.9,  browY: 1,  browTilt: 6,   mouth: 'small', accent: 'blue' },
  talking:     { eyeOpen: 1.0,  browY: 0,  browTilt: 0,   mouth: 'talk',  accent: 'cyan' },
  happy:       { eyeOpen: 0.85, browY: -2, browTilt: -6,  mouth: 'smile', accent: 'teal' },
  celebrating: { eyeOpen: 0.8,  browY: -3, browTilt: -8,  mouth: 'open',  accent: 'teal' },
  concerned:   { eyeOpen: 1.0,  browY: 2,  browTilt: 8,   mouth: 'frown', accent: 'warning' },
  confused:    { eyeOpen: 1.0,  browY: 1,  browTilt: 10,  mouth: 'small', accent: 'blue' },
  sleeping:    { eyeOpen: 0.06, browY: 1,  browTilt: 0,   mouth: 'line',  accent: 'navy' },
};

export const EXPRESSION_NAMES = Object.keys(DATA);
export const DEFAULT_EXPRESSION = 'neutral';

export function expressionFor(name) {
  return DATA[name] || DATA[DEFAULT_EXPRESSION];
}
