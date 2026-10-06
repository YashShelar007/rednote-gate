// Text cards: 1080x1440 PNGs (RedNote's 3:4) for notes that have an idea but no photos.
// Rendered by our own headless Chromium with all network blocked; never touches RedNote or the session.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

// A "\n" in the title forces a line break (Chinese has no spaces to break on).
export type Card = { title: string; lines?: string[]; footer?: string };

// Each theme is a surface students already write tips on. One accent each: the mark under the title.
const THEME_VARS: Record<string, string> = {
  notebook: "--bg:#f7f9fc;--grid:#e2e8f1;--ink:#18233a;--soft:#5b6579;--accent:#ffdf4f;--hl:56%;--mark:#18233a",
  sticky: "--bg:#ffefa3;--grid:transparent;--ink:#2a251b;--soft:#6e6450;--accent:#2f5bd3;--hl:91%;--mark:#2f5bd3",
  chalkboard: "--bg:#263d33;--grid:transparent;--ink:#f3f1e7;--soft:#b5c2b9;--accent:#9ccfef;--hl:91%;--mark:#9ccfef",
  blueprint: "--bg:#1e4b8f;--grid:rgba(255,255,255,.08);--ink:#fff;--soft:#c6d6ec;--accent:#7fe3f2;--hl:91%;--mark:#7fe3f2",
};
export const THEMES: readonly string[] = Object.keys(THEME_VARS);

const CSS = `*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1440px;overflow:hidden}
body{background:linear-gradient(var(--grid) 2px,transparent 0),linear-gradient(90deg,var(--grid) 2px,transparent 0) var(--bg);background-size:60px 60px;color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif}
main{height:1440px;padding:128px 96px 88px;display:flex;flex-direction:column;overflow:hidden}
main>*{flex-shrink:0}
h1{font-size:120px;line-height:1.3;font-weight:600;white-space:pre-line;text-wrap:balance}
.big h1{font-size:168px;margin-top:auto}
.big>:last-child:not(footer){margin-bottom:auto}
h1 span{background:linear-gradient(transparent var(--hl),var(--accent) 0)}
ul{list-style:none;margin-top:88px;font-size:46px;line-height:1.55}
li{position:relative;padding-left:1.1em;overflow-wrap:anywhere;text-wrap:pretty}
li+li{margin-top:.6em}
li::before{content:"";position:absolute;left:.1em;top:.62em;width:.32em;height:.32em;background:var(--mark)}
.big ul{margin-top:64px;color:var(--soft)}.big li{padding:0}.big li::before{content:none}
footer{margin-top:auto;padding-top:48px;display:flex;justify-content:space-between;gap:48px;font-size:30px;color:var(--soft)}`;

// Shrink the title until it fits (width, and at most ~a third of the card on list cards), then the lines.
// Block-scoped: setContent reuses the window, so a top-level const would throw on the second card.
const FIT = `{const m=document.querySelector("main"),t=document.querySelector("h1"),u=document.querySelector("ul"),
px=e=>parseFloat(getComputedStyle(e).fontSize),over=()=>m.scrollHeight>m.clientHeight||t.scrollWidth>t.clientWidth;
while(((!m.className&&t.offsetHeight>500)||over())&&px(t)>56)t.style.fontSize=px(t)-4+"px";
while(u&&over()&&px(u)>28)u.style.fontSize=px(u)-2+"px";}`;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const len = (s: string) => [...s].length;

function checkCard(c: Card, n: number): void {
  const at = `Card ${n}`;
  if (!c.title?.trim() || len(c.title) > 40) throw new Error(`${at}: the title must be 1 to 40 characters.`);
  const lines = c.lines ?? [];
  if (lines.length > 8) throw new Error(`${at}: at most 8 lines per card, got ${lines.length}.`);
  lines.forEach((l, i) => {
    if (len(l) > 60) throw new Error(`${at}, line ${i + 1}: at most 60 characters, got ${len(l)}.`);
  });
  if (c.footer && len(c.footer) > 40) throw new Error(`${at}: the footer must be at most 40 characters.`);
}

export function checkCards(cards: Card[]): void {
  if (cards.length < 1 || cards.length > 9) throw new Error(`A card set has 1 to 9 cards, got ${cards.length}.`);
  cards.forEach((c, i) => checkCard(c, i + 1));
}

/** index is 1-based; "index/total" is shown when total > 1. */
export function cardHtml(card: Card, theme: string, index: number, total: number): string {
  if (!(theme in THEME_VARS)) throw new Error(`Unknown theme "${theme}". Use one of: ${THEMES.join(", ")}.`);
  checkCard(card, index);
  const lines = card.lines ?? [];
  const list = lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
  const foot = card.footer || total > 1
    ? `<footer><span>${esc(card.footer ?? "")}</span><span>${total > 1 ? `${index}/${total}` : ""}</span></footer>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>:root{${THEME_VARS[theme]}}${CSS}</style></head>` +
    `<body><main${lines.length > 2 ? "" : ` class="big"`}><h1><span>${esc(card.title)}</span></h1>${list}${foot}</main>` +
    `<script>${FIT}</script></body></html>`;
}

export async function renderCards(cards: Card[], outDir: string, theme = THEMES[0]): Promise<string[]> {
  checkCards(cards);
  const pages = cards.map((c, i) => cardHtml(c, theme, i + 1, cards.length)); // all validation before any browser
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
    await page.route("**/*", (r) => r.abort());
    const stamp = Date.now();
    const out: string[] = [];
    for (const [i, html] of pages.entries()) {
      const file = join(dir, `card-${stamp}-${i + 1}.png`);
      await page.setContent(html);
      await page.screenshot({ path: file });
      out.push(file);
    }
    return out;
  } finally {
    await browser.close();
  }
}
