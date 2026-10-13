// Drawing helpers for the Marketplace illustrations.
//
// Every illustration is a plain SVG string. These helpers keep the scenes in
// scenes.mjs short and make sure every image shares one palette, one font stack
// and one set of icons. Nothing here touches the disk except reading the Forgejo
// logo once, and nothing needs a package from npm.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Font stacks. The images are rendered once by Chrome and saved as PNG, so a
// system font is fine: nothing has to load on a customer's machine.
export const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
export const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

// One palette for every image. The orange and red are the two colours of the
// Forgejo mark; the rest are neutral UI colours.
export const C = {
  ink: '#172b4d',
  muted: '#5b6b86',
  faint: '#8c9bb5',
  line: '#dfe3ec',
  skeleton: '#e6eaf2',
  white: '#ffffff',
  canvasTop: '#f7f9fd',
  canvasBottom: '#e9eff9',
  navy: '#0e1a33',
  navy2: '#1a2c55',
  blue: '#0c66e4',
  blueBg: '#e9f2ff',
  green: '#1f845a',
  greenBg: '#dcfff1',
  red: '#c9372c',
  redBg: '#ffeceb',
  purple: '#6e5dc6',
  purpleBg: '#f3f0ff',
  amber: '#9a6b00',
  amberBg: '#fff4cc',
  orange: '#ff6600',
  orangeBg: '#fff0e5',
  deepRed: '#d40000',
  code: '#0f172a',
};

// ---------------------------------------------------------------------------
// Low-level pieces
// ---------------------------------------------------------------------------

/** Escape text so it is safe inside an SVG attribute or element. */
export const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Estimate how wide a string will render. SVG cannot measure text for us, and
 * we only need a close figure to size pills and lozenges around their label.
 */
export function textWidth(str, size, { weight = 400, mono = false } = {}) {
  const factor = mono ? 0.6 : weight >= 600 ? 0.58 : 0.54;
  return Math.ceil(String(str).length * size * factor);
}

/** A line of text. `y` is the text baseline. */
export function text(x, y, str, opts = {}) {
  const {
    size = 16,
    weight = 400,
    fill = C.ink,
    anchor = 'start',
    mono = false,
    spacing = 0,
    opacity = 1,
  } = opts;
  const extra =
    (spacing ? ` letter-spacing="${spacing}"` : '') +
    (opacity < 1 ? ` opacity="${opacity}"` : '');
  return (
    `<text x="${x}" y="${y}" font-family="${mono ? MONO : FONT}" ` +
    `font-size="${size}" font-weight="${weight}" fill="${fill}" ` +
    `text-anchor="${anchor}"${extra}>${esc(str)}</text>`
  );
}

/** A rectangle. Pass `shadow: 'lg' | 'sm'` for a drop shadow. */
export function rect(x, y, w, h, opts = {}) {
  const { r = 0, fill = 'none', stroke, sw = 1, shadow, opacity = 1, dash } = opts;
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `width="${w}"`,
    `height="${h}"`,
    r ? `rx="${r}"` : '',
    `fill="${fill}"`,
    stroke ? `stroke="${stroke}" stroke-width="${sw}"` : '',
    dash ? `stroke-dasharray="${dash}"` : '',
    shadow ? `filter="url(#shadow-${shadow})"` : '',
    opacity < 1 ? `opacity="${opacity}"` : '',
  ];
  return `<rect ${attrs.filter(Boolean).join(' ')}/>`;
}

export const circle = (cx, cy, r, fill, extra = '') =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;

export const line = (x1, y1, x2, y2, color = C.line, width = 1, extra = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ` +
  `stroke-width="${width}" ${extra}/>`;

/** A grey placeholder bar standing in for a line of text we do not need to read. */
export const bar = (x, y, w, h = 10, fill = C.skeleton) =>
  rect(x, y, w, h, { r: h / 2, fill });

// ---------------------------------------------------------------------------
// Shared definitions: shadows, glows, dot grid and arrowheads
// ---------------------------------------------------------------------------

const DEFS = `<defs>
  <filter id="shadow-lg" x="-15%" y="-15%" width="130%" height="140%">
    <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#172b4d" flood-opacity="0.16"/>
  </filter>
  <filter id="shadow-sm" x="-10%" y="-10%" width="120%" height="130%">
    <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#172b4d" flood-opacity="0.12"/>
  </filter>
  <linearGradient id="canvas" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.canvasTop}"/>
    <stop offset="1" stop-color="${C.canvasBottom}"/>
  </linearGradient>
  <linearGradient id="night" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.navy}"/>
    <stop offset="1" stop-color="${C.navy2}"/>
  </linearGradient>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="1" stop-color="#ffe9d6"/>
  </linearGradient>
  <radialGradient id="glow-orange">
    <stop offset="0" stop-color="${C.orange}" stop-opacity="0.20"/>
    <stop offset="1" stop-color="${C.orange}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glow-blue">
    <stop offset="0" stop-color="${C.blue}" stop-opacity="0.16"/>
    <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
    <circle cx="2" cy="2" r="1.4" fill="#c4cde0"/>
  </pattern>
  <marker id="arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
    <path d="M1 1 L9 5 L1 9 z" fill="${C.muted}"/>
  </marker>
  <marker id="arrow-orange" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
    <path d="M1 1 L9 5 L1 9 z" fill="${C.orange}"/>
  </marker>
  <marker id="arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
    <path d="M1 1 L9 5 L1 9 z" fill="${C.blue}"/>
  </marker>
</defs>`;

/** Wrap scene content in an SVG document. `viewBox` lets us crop a scene. */
export function svgDoc(width, height, body, viewBox) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${viewBox ?? `0 0 ${width} ${height}`}">${DEFS}${body}</svg>`
  );
}

/** The light backdrop used by every highlight and gallery image. */
export function background(w, h) {
  return [
    rect(0, 0, w, h, { fill: 'url(#canvas)' }),
    rect(0, 0, w, h, { fill: 'url(#dots)', opacity: 0.55 }),
    circle(w * 0.1, h * 0.12, 420, 'url(#glow-orange)'),
    circle(w * 0.92, h * 0.95, 460, 'url(#glow-blue)'),
  ].join('');
}

/** An arrow between two points. `tone` picks the arrowhead colour. */
export function arrow(x1, y1, x2, y2, { tone = 'muted', width = 3, dash } = {}) {
  const colour = { muted: C.muted, orange: C.orange, blue: C.blue }[tone];
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colour}" ` +
    `stroke-width="${width}" stroke-linecap="round" ` +
    `${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="url(#arrow-${tone})"/>`
  );
}

// ---------------------------------------------------------------------------
// The Forgejo mark
// ---------------------------------------------------------------------------

// The logo is embedded exactly as published by the Forgejo project, as an
// image, so its own stylesheet cannot leak into our shapes. See NOTICE.md.
const LOGO_URI =
  'data:image/svg+xml;base64,' +
  readFileSync(join(here, 'assets', 'forgejo-logo.svg')).toString('base64');

export const forgejoMark = (x, y, size) =>
  `<image x="${x}" y="${y}" width="${size}" height="${size}" href="${LOGO_URI}"/>`;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// Each icon is drawn on a 24 x 24 grid with a 2px round stroke.
const ICONS = {
  commit:
    '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
  branch:
    '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="8" r="2.5"/>' +
    '<path d="M6 7.5v9M18 10.5c0 4.5-12 2.5-12 6"/>',
  pullRequest:
    '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/>' +
    '<path d="M6 8v8M18 16V10a3 3 0 0 0-3-3h-4M13.5 3.5 10.5 7l3 3.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  cross: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  progress: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  deploy: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  flag: '<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>',
  shield:
    '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  webhook:
    '<circle cx="12" cy="6" r="3"/><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/>' +
    '<path d="m10.5 8.5-3 6M13.5 8.5l3 6M9 17h6"/>',
};

/** Draw a named icon with its top-left corner at (x, y). */
export function icon(name, x, y, size = 24, color = C.ink, sw = 2) {
  return (
    `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" ` +
    `stroke="${color}" stroke-width="${sw}" stroke-linecap="round" ` +
    `stroke-linejoin="round">${ICONS[name]}</g>`
  );
}

// ---------------------------------------------------------------------------
// UI building blocks
// ---------------------------------------------------------------------------

// Lozenge colours follow the status colours used across Jira.
const LOZENGE = {
  success: ['#dcfff1', '#216e4e'],
  info: ['#cfe1fd', '#0055cc'],
  removed: ['#ffd5d2', '#ae2e24'],
  moved: ['#dfd8fd', '#5e4db2'],
  warning: ['#f8e6a0', '#7f5f01'],
  neutral: ['#dcdfe4', '#44546f'],
};

/**
 * Width a lozenge needs for its label. Lozenge text is bold upper case with a
 * little letter spacing, which is wider than the general estimate in textWidth.
 */
export const lozengeWidth = (label, size = 12) =>
  Math.ceil(label.length * (size * 0.68 + 0.3)) + 18;

/** A status lozenge. (x, y) is the top-left corner. Returns the SVG string. */
export function lozenge(x, y, label, tone = 'neutral', size = 12) {
  const [bg, fg] = LOZENGE[tone];
  const h = size + 10;
  const w = lozengeWidth(label, size);
  return (
    rect(x, y, w, h, { r: 4, fill: bg }) +
    text(x + 8, y + h / 2 + size * 0.36, label.toUpperCase(), {
      size,
      weight: 700,
      fill: fg,
      spacing: 0.3,
    })
  );
}

/** A round avatar with initials. */
export function avatar(cx, cy, r, initials, color) {
  return (
    circle(cx, cy, r, color) +
    text(cx, cy + r * 0.36, initials, {
      size: r * 0.95,
      weight: 700,
      fill: C.white,
      anchor: 'middle',
    })
  );
}

/**
 * A button. (x, y) is the top-left corner. `fill` overrides the background for
 * one-off colours, such as the green button on Forgejo's own consent screen.
 */
export function button(x, y, w, h, label, { primary = false, danger = false, size = 15, fill: override } = {}) {
  const fill = override ?? (primary ? C.blue : danger ? C.redBg : '#f1f2f4');
  const ink = primary || override ? C.white : danger ? C.red : C.ink;
  return (
    rect(x, y, w, h, { r: 6, fill }) +
    text(x + w / 2, y + h / 2 + size * 0.36, label, {
      size,
      weight: 600,
      fill: ink,
      anchor: 'middle',
    })
  );
}

/** An on/off switch, 44 x 24. */
export function toggle(x, y, on) {
  return (
    rect(x, y, 44, 24, { r: 12, fill: on ? C.green : '#b3b9c4' }) +
    circle(on ? x + 32 : x + 12, y + 12, 9, C.white)
  );
}

/** A text input drawn as an empty field with its value in it. */
export function field(x, y, w, label, value, { mono = false } = {}) {
  return (
    text(x, y, label, { size: 14, weight: 600, fill: C.muted }) +
    rect(x, y + 10, w, 42, { r: 6, fill: C.white, stroke: '#b9c2d3', sw: 1.5 }) +
    text(x + 14, y + 37, value, { size: 16, fill: C.ink, mono })
  );
}

/** A pill with an icon and a label, such as "2 commits". */
export function chip(x, y, iconName, label, color = C.ink, bg = C.white, size = 16) {
  const w = textWidth(label, size, { weight: 600 }) + size + 40;
  return {
    width: w,
    svg:
      rect(x, y, w, size + 18, { r: (size + 18) / 2, fill: bg, stroke: C.line, shadow: 'sm' }) +
      icon(iconName, x + 12, y + 9, size, color, 2.2) +
      text(x + 12 + size + 8, y + (size + 18) / 2 + size * 0.36, label, { size, weight: 600, fill: C.ink }),
  };
}

/**
 * A browser-style window. The chrome (title bar and URL) is drawn here and
 * `inner` is clipped to the window's rounded corners. `inner` uses the same
 * absolute coordinates as everything else, so scenes stay easy to reason about.
 * Returns the SVG string for the whole window.
 */
export function windowFrame(id, x, y, w, h, { url = '', inner = '', dark = false } = {}) {
  const bar = 52;
  return (
    rect(x, y, w, h, { r: 18, fill: dark ? C.code : C.white, stroke: dark ? '#26324d' : C.line, shadow: 'lg' }) +
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18"/></clipPath>` +
    `<g clip-path="url(#${id})">` +
    rect(x, y, w, bar, { fill: dark ? '#162036' : '#f4f6fa' }) +
    line(x, y + bar, x + w, y + bar, dark ? '#26324d' : C.line) +
    circle(x + 28, y + bar / 2, 7, '#ff5f57') +
    circle(x + 52, y + bar / 2, 7, '#febc2e') +
    circle(x + 76, y + bar / 2, 7, '#28c840') +
    (url
      ? rect(x + 110, y + 11, w - 220, 30, { r: 15, fill: dark ? '#0f172a' : C.white, stroke: dark ? '#26324d' : C.line }) +
        icon('lock', x + 128, y + 18, 15, C.faint, 2.2) +
        text(x + 154, y + 31, url, { size: 14, fill: C.muted, mono: true })
      : '') +
    inner +
    `</g>`
  );
}

/** A numbered step badge that sits on a window corner. */
export function stepBadge(cx, cy, n) {
  return (
    circle(cx, cy, 26, C.orange, `stroke="${C.white}" stroke-width="5"`) +
    text(cx, cy + 9, String(n), { size: 26, weight: 800, fill: C.white, anchor: 'middle' })
  );
}

// ---------------------------------------------------------------------------
// Development panel rows
// ---------------------------------------------------------------------------

// What each kind of development item looks like: its icon, and the colours
// of the round badge the icon sits in.
const KIND = {
  branch: { icon: 'branch', color: C.purple, bg: C.purpleBg },
  pullRequest: { icon: 'pullRequest', color: C.blue, bg: C.blueBg },
  commit: { icon: 'commit', color: C.muted, bg: '#eef1f6' },
  build: { icon: 'check', color: C.green, bg: C.greenBg },
  deploy: { icon: 'deploy', color: C.green, bg: C.greenBg },
  flag: { icon: 'flag', color: C.orange, bg: C.orangeBg },
};

/**
 * One row of the Development panel: a round icon badge, a title, a line of
 * detail and an optional lozenge on the right edge.
 */
export function devRow(x, y, w, kind, title, meta, tag, { scale = 1, mono = false } = {}) {
  const k = KIND[kind];
  const r = 22 * scale;
  const cy = y + 44 * scale;
  const out = [
    circle(x + r + 4, cy, r, k.bg),
    icon(k.icon, x + 4 + r - 12 * scale, cy - 12 * scale, 24 * scale, k.color, 2.1),
    text(x + r * 2 + 24, cy - 3 * scale, title, {
      size: 20 * scale,
      weight: 600,
      mono,
    }),
    text(x + r * 2 + 24, cy + 24 * scale, meta, { size: 15 * scale, fill: C.muted }),
  ];
  if (tag) {
    out.push(lozenge(x + w - lozengeWidth(tag[0], 12 * scale) - 4, cy - 14 * scale, tag[0], tag[1], 12 * scale));
  }
  return out.join('');
}
