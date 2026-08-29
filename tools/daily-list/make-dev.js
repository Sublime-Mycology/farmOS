#!/usr/bin/env node
/*
 * index.html is the *body* of a claude.ai Artifact: the host supplies the
 * doctype, charset and viewport at publish time, so the file must not carry
 * them itself. Opening it directly over file:// therefore lands in quirks mode
 * with no declared encoding, which mangles the punctuation.
 *
 * This writes dev.html — the same page inside the skeleton the host would add —
 * for local development and browser testing. dev.html is generated; edit
 * index.html.
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const body = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui,sans-serif;background:#fafaf8}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
const dest = path.join(dir, 'dev.html');
fs.writeFileSync(dest, out);
console.log('wrote ' + dest);
