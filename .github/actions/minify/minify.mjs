// Minify HTML, standalone CSS and standalone JS in a built site directory.
// Used by the shared GiellaLT docs pipeline (.github/workflows/docs.yml) and by
// giellalt.github.io's own workflow, run after the Jekyll build and before
// Pagefind indexing.
//
// - HTML  -> @minify-html/node (whitespace-aware; collapses the large blocks of
//            template whitespace Liquid loops leave behind). Inline <script> and
//            <style> are left untouched: minify-html's bundled JS minifier
//            panics on some of our code, and inline CSS/JS is negligible here.
// - CSS   -> csso
// - JS    -> terser (ESM-aware; the docs JS is a mix of classic IIFEs and
//            ES modules under assets/js/)
//
// Resilient by design: a file that fails to minify is left untouched and the
// run still exits 0. A pipeline shared by every lang-/keyboard-/speech-/dict-
// docs site must never break a whole site over one odd file.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';
import minifyHtmlMod from '@minify-html/node';
import { minify as minifyJs } from 'terser';
import { minify as minifyCss } from 'csso';

const root = process.argv[2] || '_site';

// Paths (root-relative, POSIX-style) we never touch: third-party or pre-built
// bundles that are already minified or too fragile to re-parse.
const SKIP_DIRS = ['pagefind', 'assets/typosreport'];
const skip = (rel) =>
  SKIP_DIRS.some((d) => rel === d || rel.startsWith(d + '/')) ||
  /\.min\.(js|css)$/.test(rel);

const HTML_OPTS = {
  keep_spaces_between_attributes: true,
  keep_comments: false,
  keep_html_and_head_opening_tags: true,
  keep_closing_tags: true,
  minify_css: false,
  minify_js: false,
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let html = 0, css = 0, js = 0, failed = 0, saved = 0;

for await (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/');
  if (skip(rel)) continue;
  const ext = extname(file).toLowerCase();
  if (ext !== '.html' && ext !== '.css' && ext !== '.js') continue;

  let buf;
  try {
    buf = await readFile(file);
  } catch {
    continue;
  }
  const before = buf.length;
  let out;

  try {
    if (ext === '.html') {
      out = minifyHtmlMod.minify(buf, HTML_OPTS).toString('utf8');
      html++;
    } else if (ext === '.css') {
      out = minifyCss(buf.toString('utf8')).css;
      css++;
    } else {
      const src = buf.toString('utf8');
      // Parse as an ES module only when the file uses top-level import/export —
      // otherwise terser rejects a classic script, and module mode would wrongly
      // enable top-level mangling on it.
      const isModule = /(^|[\s;])(import|export)[\s{*(]/.test(src);
      const res = await minifyJs(src, {
        ecma: 2020,
        module: isModule,
        compress: true,
        mangle: true,
        format: { comments: false },
      });
      out = res.code;
      js++;
    }
  } catch (err) {
    console.warn(`skip (minify failed): ${rel} — ${String(err.message).split('\n')[0]}`);
    failed++;
    continue;
  }

  if (typeof out !== 'string' || out.length === 0 || Buffer.byteLength(out) >= before) {
    continue; // no gain, or unexpected empty output — keep the original
  }
  await writeFile(file, out);
  saved += before - Buffer.byteLength(out);
}

console.log(
  `minify: ${html} html, ${css} css, ${js} js — ${(saved / 1024).toFixed(0)} KiB saved` +
    (failed ? `, ${failed} left as-is after error` : ''),
);
