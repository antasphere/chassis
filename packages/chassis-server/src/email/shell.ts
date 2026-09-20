/**
 * The mail shell: the one layout every transactional email is set in, and the
 * few blocks a builder composes a body from. The hub and Slideless carry this
 * file BYTE-IDENTICAL (the twin rule, LESSONS.md): change one, copy it to the
 * other. What differs per product is the `MailBrand` its templates.ts passes.
 *
 * The look is the dashboards': the creme paper, the umber accent, the serif
 * display face over the sans body, mono field-note labels, and the grain over
 * a gradient as a band at the top of the card.
 *
 * Mail clients are not browsers, which shapes three choices here:
 *  - The grain band and the mark are hosted IMAGES (`/email/band.jpg`,
 *    `/email/mark.png`, served from the dashboard's static folder). Gmail
 *    strips SVG and data URIs, so neither can travel inline. Until
 *    `setEmailAssets` is called (or where images are blocked) the band falls
 *    back to a plain CSS gradient and the header to the name alone.
 *  - Layout is tables and inline styles; the webfonts load where the client
 *    allows a stylesheet (Apple Mail, iOS) and fall back to Georgia and the
 *    system sans everywhere else.
 *  - `color-scheme: light` keeps a dark-mode client from inverting the paper.
 *
 * Env-free like the builders: the asset urls are handed in once at boot, so a
 * preview script can hand in its own.
 */

export interface MailBrand {
  /** The product's name, as the header and the footer say it. */
  name: string;
  /** One line under the footer's name: what this product is. */
  tagline: string;
}

export interface EmailAssets {
  /** The grain-over-gradient band, 1200x320. */
  band: string;
  /** The woven-A mark, transparent, 120x120. */
  mark: string;
}

let assets: EmailAssets | null = null;

/** Hand the shell its two image urls. Called once at boot; the preview hands in its own. */
export function setEmailAssets(next: EmailAssets | null): void {
  assets = next;
}

/** The two urls as an instance serves them, from the dashboard's static folder. */
export function emailAssetsAt(publicBaseUrl: string): EmailAssets {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return { band: `${base}/email/band.jpg`, mark: `${base}/email/mark.png` };
}

/** Nothing reaches email HTML unescaped: user text, and urls in attributes alike. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const INK = '#1c1915';
const INK_SOFT = '#35302a';
const MUTED = '#6e6759';
const HAIRLINE = '#e0daca';
const GROUND = '#f1ede1';
const SHEET = '#fbf9f3';
const PLATE = '#f4f0e5';
const ACCENT = '#7a6652';
const ACCENT_INK = '#f7f4ec';

const DISPLAY = "'Sentient',Georgia,'Times New Roman',serif";
const UI = "'Synonym',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

/** A date the way a person says it: "Thursday 22 January 2026, 14:00 UTC". */
export function fmtDate(d: Date): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).format(d);
  return `${day.replace(',', '')}, ${time} UTC`;
}

// ─── Blocks ──────────────────────────────────────────────────────────
// Each takes HTML that is already safe: the builder escapes user text.

/** A paragraph of body copy. */
export const para = (html: string): string =>
  `<p style="margin:0 0 18px;font-family:${UI};font-size:15px;line-height:1.65;color:${INK_SOFT}">${html}</p>`;

/** The one thing to do. */
export const button = (url: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 26px"><tr>
<td style="border-radius:16px;background:${ACCENT}">
<a href="${esc(url)}" style="display:inline-block;padding:12px 24px;border-radius:16px;font-family:${UI};font-size:15px;font-weight:500;color:${ACCENT_INK};text-decoration:none">${label}</a>
</td></tr></table>`;

/** The other thing to do, when a mail offers two. */
export const quietButton = (url: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 26px"><tr>
<td style="border-radius:16px;border:1px solid ${HAIRLINE};background:${SHEET}">
<a href="${esc(url)}" style="display:inline-block;padding:11px 23px;border-radius:16px;font-family:${UI};font-size:15px;font-weight:500;color:${INK};text-decoration:none">${label}</a>
</td></tr></table>`;

/** Someone's own words, set apart from ours. */
export const quote = (html: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>
<td style="border-left:2px solid ${ACCENT};padding:4px 0 4px 16px;font-family:${DISPLAY};font-size:17px;line-height:1.55;font-style:italic;color:${INK}">${html}</td>
</tr></table>`;

/** A plate of labelled facts: mono field-note labels over the values. */
export const facts = (rows: Array<[label: string, valueHtml: string]>): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:${PLATE};border:1px solid ${HAIRLINE};border-radius:12px"><tr><td style="padding:6px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows
    .map(
      ([label, value], i) => `<tr>
<td style="padding:11px 16px 11px 0;${i > 0 ? `border-top:1px solid ${HAIRLINE};` : ''}font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};white-space:nowrap;vertical-align:top;width:1%">${label}</td>
<td style="padding:9px 0;${i > 0 ? `border-top:1px solid ${HAIRLINE};` : ''}font-family:${UI};font-size:14px;line-height:1.5;color:${INK};vertical-align:top">${value}</td>
</tr>`
    )
    .join('')}</table>
</td></tr></table>`;

/** A code to type, large enough to read across a desk. */
export const codePlate = (code: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:${PLATE};border:1px solid ${HAIRLINE};border-radius:12px"><tr>
<td align="center" style="padding:22px 12px;font-family:${MONO};font-size:34px;font-weight:600;letter-spacing:0.28em;color:${INK}">${esc(code)}</td>
</tr></table>`;

/** The small print under the action. */
export const fine = (html: string): string =>
  `<p style="margin:0 0 10px;font-family:${UI};font-size:13px;line-height:1.6;color:${MUTED}">${html}</p>`;

/** The link spelled out, for when the button does not work. */
export const spelledLink = (url: string): string =>
  `<p style="margin:0;font-family:${UI};font-size:12px;line-height:1.6;color:${MUTED}">Button not working? Paste this into your browser:<br>
<span style="font-family:${MONO};font-size:11px;word-break:break-all;color:${MUTED}">${esc(url)}</span></p>`;

// ─── The shell ───────────────────────────────────────────────────────

export interface ShellParts {
  /** The inbox preview line, hidden in the body. */
  preheader: string;
  /** The mono label over the title: what kind of mail this is. */
  eyebrow: string;
  /** The title, already escaped. */
  title: string;
  /** The blocks. */
  body: string;
}

export function makeShell(brand: MailBrand): (parts: ShellParts) => string {
  return (parts) => {
    const band = assets
      ? `background-color:#e6dccb;background-image:url('${esc(assets.band)}');background-size:cover;background-position:center`
      : 'background-color:#e6dccb;background-image:linear-gradient(115deg,#f6f0e4 0%,#ece4d6 45%,#d9c6ac 80%,#c9b193 100%)';
    const mark = assets
      ? `<td style="padding-right:11px;vertical-align:middle"><img src="${esc(assets.mark)}" width="34" height="34" alt="" style="display:block;border:0"></td>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(brand.name)}</title>
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f%5B%5D=sentient@300,400&f%5B%5D=synonym@400,500&display=swap">
</head>
<body style="margin:0;padding:0;background:${GROUND}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${GROUND};font-size:1px;line-height:1px">${esc(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND}">
<tr><td align="center" style="padding:36px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${SHEET};border:1px solid ${HAIRLINE};border-radius:18px;overflow:hidden">
<tr><td height="124" style="height:124px;padding:0 36px 22px;vertical-align:bottom;border-bottom:1px solid ${HAIRLINE};${band}">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    ${mark}
    <td style="vertical-align:middle;font-family:${DISPLAY};font-size:23px;font-weight:300;letter-spacing:-0.01em;color:${INK}">${esc(brand.name)}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:34px 36px 30px">
  <p style="margin:0 0 12px;font-family:${MONO};font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${ACCENT}">${esc(parts.eyebrow)}</p>
  <h1 style="margin:0 0 20px;font-family:${DISPLAY};font-size:29px;line-height:1.2;font-weight:300;letter-spacing:-0.015em;color:${INK}">${parts.title}</h1>
  ${parts.body}
</td></tr>
<tr><td style="padding:20px 36px 24px;border-top:1px solid ${HAIRLINE};background:${PLATE}">
  <p style="margin:0 0 3px;font-family:${DISPLAY};font-size:15px;font-weight:400;color:${INK}">${esc(brand.name)}</p>
  <p style="margin:0;font-family:${UI};font-size:12px;line-height:1.55;color:${MUTED}">${esc(brand.tagline)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  };
}
