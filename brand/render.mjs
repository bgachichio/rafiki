// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerates every raster from the SVG sources in this folder. Run from the site folder: node brand/render.mjs
// Needs Playwright's Chromium (for example from ~/projects/mypdf/node_modules).
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, 'icons'), { recursive: true })
const svg = (f) => readFileSync(resolve(root, 'brand', f), 'utf8')
const fonts = `@font-face{font-family:'Courier Prime';src:url(data:font/woff2;base64,${readFileSync(resolve(root, 'fonts/CourierPrime-Regular.woff2')).toString('base64')}) format('woff2')}`
const jobs = [
  ['icon.svg', 'icons/icon-192.png', 192, 192, true],
  ['icon.svg', 'icons/icon-512.png', 512, 512, true],
  ['icon-maskable.svg', 'icons/icon-maskable-512.png', 512, 512, false],
  ['icon-maskable.svg', 'icons/apple-touch-icon.png', 180, 180, false],
  ['icon.svg', 'icons/favicon-32.png', 32, 32, true],
  ['icon.svg', 'icons/favicon-16.png', 16, 16, true],
  ['og.svg', 'og-image.png', 1200, 630, false],
]
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [src, out, w, h, transparent] of jobs) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<style>${fonts}html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${svg(src)}`)
  await page.evaluate(() => document.fonts.ready)
  writeFileSync(resolve(root, out), await page.screenshot({ omitBackground: transparent, type: 'png' }))
  console.log('wrote', out)
}
await browser.close()
