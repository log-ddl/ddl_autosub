// Renders a few still frames of one composition for preview_motion. AutoSubs
// writes this file into the kit (so its imports resolve to the kit's
// node_modules) and runs `node stills.mjs <request.json>`. Bundling once and
// reusing one browser for every frame is what makes this faster than one
// `remotion still` per frame.
//
// Request: { entry, composition, props, browser, gl, outDir, frames?, atSec?, maxSide }
// Writes outDir/result.json: { fps, durationInFrames, width, height, stills: [{ frame, path }] }

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";

const req = JSON.parse(readFileSync(process.argv[2], "utf8"));
const inputProps = req.props ?? {};

// Only the message: a React stack trace would fill the error tail AutoSubs
// returns to the agent and hide what went wrong.
process.on("uncaughtException", (e) => fail(e));
process.on("unhandledRejection", (e) => fail(e));
function fail(e) {
  console.error(e?.message ?? String(e));
  process.exit(1);
}

const serveUrl = await bundle({ entryPoint: req.entry });
// WebGL (light leaks, Lottie's canvas renderer, shaders) needs a GL backend
// in the headless browser.
const browser = await openBrowser("chrome", { browserExecutable: req.browser, chromiumOptions: { gl: req.gl } });
try {
  const composition = await selectComposition({
    serveUrl,
    id: req.composition,
    inputProps,
    puppeteerInstance: browser,
    browserExecutable: req.browser,
  });
  const last = composition.durationInFrames - 1;
  let frames;
  if (Array.isArray(req.atSec) && req.atSec.length > 0) {
    frames = req.atSec.map((s) => Math.min(last, Math.max(0, Math.round(s * composition.fps))));
  } else {
    // Evenly spread, centred in each slice, so neither the empty first frame
    // nor the faded-out last one fills a tile.
    const n = Math.max(1, Math.min(req.frames ?? 12, composition.durationInFrames));
    frames = Array.from({ length: n }, (_, i) => Math.min(last, Math.floor(((i + 0.5) * composition.durationInFrames) / n)));
  }
  frames = [...new Set(frames)].sort((a, b) => a - b);

  const scale = Math.min(1, req.maxSide / Math.max(composition.width, composition.height));
  const stills = [];
  for (const frame of frames) {
    const output = join(req.outDir, `frame-${String(frame).padStart(5, "0")}.png`);
    await renderStill({
      composition,
      serveUrl,
      output,
      frame,
      inputProps,
      imageFormat: "png",
      scale,
      puppeteerInstance: browser,
      browserExecutable: req.browser,
      logLevel: "error",
    });
    stills.push({ frame, path: output });
  }
  writeFileSync(
    join(req.outDir, "result.json"),
    JSON.stringify({
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      width: composition.width,
      height: composition.height,
      stills,
    }),
  );
} finally {
  await browser.close({ silent: true });
}
