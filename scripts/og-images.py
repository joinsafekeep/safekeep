#!/usr/bin/env python3
"""Make a 1200x630 social-sharing image for each scam alert.

    python3 scripts/og-images.py          # only articles without an image
    python3 scripts/og-images.py --all    # redo every image

Writes og/<slug>.png. Run it before scripts/build-scam-alerts.mjs, which uses
og/<slug>.png when it exists and falls back to the homepage photo otherwise.

Needs Python Playwright with Chromium (pip install playwright; python3 -m
playwright install chromium). Fonts are bundled in scripts/og-fonts (SIL OFL).
"""
import asyncio
import base64
import html
import pathlib
import re
import sys

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content" / "scam-alerts"
OUT = ROOT / "og"
FONT_DIR = ROOT / "scripts" / "og-fonts"


def font(name):
    data = base64.b64encode((FONT_DIR / name).read_bytes()).decode()
    return f"data:font/woff2;base64,{data}"


def front_matter(path):
    text = path.read_text(encoding="utf-8")
    block = re.match(r"^---\n([\s\S]*?)\n---", text).group(1)
    meta = {}
    for line in block.splitlines():
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta


def curly(s):
    s = re.sub(r'(^|[\s(\[])"', "\\1\u201c", s).replace('"', "\u201d")
    s = re.sub(r"(^|[\s(\[])'", "\\1\u2018", s).replace("'", "\u2019")
    return s


def page(title, label):
    size = 74 if len(title) <= 55 else 62 if len(title) <= 80 else 54
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:DM;src:url({font("dm-sans-latin-400-normal.woff2")});font-weight:400}}
@font-face{{font-family:DM;src:url({font("dm-sans-latin-600-normal.woff2")});font-weight:600}}
@font-face{{font-family:Caslon;src:url({font("libre-caslon-display-latin-400-normal.woff2")})}}
*{{box-sizing:border-box;margin:0}}
body{{width:1200px;height:630px;background:#fcfaf5;color:#233e34;font-family:DM;position:relative;overflow:hidden}}
.band{{position:absolute;right:0;top:0;bottom:0;width:26px;background:#254d3e}}
.inner{{position:absolute;left:84px;right:120px;top:70px;bottom:64px;display:flex;flex-direction:column}}
.brand{{display:flex;align-items:center;font-weight:600;font-size:40px;letter-spacing:-2px}}
.mark{{background:#254d3e;color:#fcfaf5;width:44px;height:48px;border-radius:15px 15px 20px 20px;font-family:Caslon;text-align:center;line-height:43px;margin-right:11px;transform:rotate(-7deg);font-size:36px;letter-spacing:0}}
.dot{{color:#c17855}}
.label{{margin-top:auto;font-size:19px;font-weight:600;letter-spacing:2.6px;text-transform:uppercase;color:#6a805a;margin-bottom:22px}}
h1{{font-family:Caslon;font-weight:400;font-size:{size}px;line-height:1.06;letter-spacing:-1.5px;max-width:960px}}
.url{{margin-top:34px;font-size:22px;color:#5d685e}}
</style></head><body><div class="band"></div><div class="inner">
<div class="brand"><span class="mark">s</span>safekeep<span class="dot">.</span></div>
<p class="label">Scam alerts · {html.escape(label)}</p>
<h1>{html.escape(curly(title))}</h1>
<p class="url">joinsafekeep.com/scam-alerts</p>
</div></body></html>"""


async def main(redo_all):
    OUT.mkdir(exist_ok=True)
    todo = []
    for md in sorted(CONTENT.glob("*.md")):
        meta = front_matter(md)
        slug = meta.get("slug") or md.stem
        target = OUT / f"{slug}.png"
        if redo_all or not target.exists():
            todo.append((meta, target))
    if not todo:
        print("All share images already exist.")
        return
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        tab = await browser.new_page(viewport={"width": 1200, "height": 630})
        for meta, target in todo:
            await tab.set_content(page(meta["title"], meta.get("type", "Guide")))
            await tab.evaluate("document.fonts.ready")
            await tab.screenshot(path=str(target))
            print(f"Wrote {target.relative_to(ROOT)}")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main("--all" in sys.argv))
