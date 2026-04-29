// Generates review.html from ./frames/*.html as a self-contained storyboard preview.
const fs = require('fs');
const path = require('path');

const FRAMES = [
  { id: '01', file: 'frame-01-established-app.html',  title: 'The Established App',   timing: '0–6s',
    voiceover: `Your Swing application works. It's been serving your organization reliably for years. But the world around it has changed.` },
  { id: '02', file: 'frame-02-growing-friction.html', title: 'Growing Friction',      timing: '6–16s',
    voiceover: `Every release means coordinating rollouts across machines. Finding developers who want to work in Swing is getting harder. And running a client-side JVM on every desktop creates security and compliance exposure you shouldn't have to manage.` },
  { id: '03', file: 'frame-03-rewrite-trap.html',     title: 'The Rewrite Trap',      timing: '16–22s',
    voiceover: `The typical first instinct is to rewrite the application for the web. But rewrites are expensive, risky, and slow. Many never finish.` },
  { id: '04', file: 'frame-04-toolkit-intro.html',    title: 'Toolkit Introduction',  timing: '22–28s',
    voiceover: `Vaadin's Swing Modernization Toolkit offers a different approach. It lets you move your Swing application to the web immediately — and then modernize it at your own pace.` },
  { id: '05', file: 'frame-05-browser-reveal.html',   title: 'Browser Reveal',        timing: '28–40s',
    voiceover: `It starts with browser access. Your existing Swing application — unchanged — runs on the server and is delivered through the browser. Your users access it through a URL, like any other web application. No desktop installs, no client-side JVM, no per-machine updates.` },
  { id: '06', file: 'frame-06-simplification.html',   title: 'Simplification',        timing: '40–48s',
    voiceover: `This can happen in days, not months. And it immediately simplifies deployment, improves your security posture, and gives your users browser-based access to the application they already rely on.` },
  { id: '07', file: 'frame-07-hybrid-state.html',     title: 'Hybrid State',          timing: '48–56s',
    voiceover: `From there, you modernize incrementally. One view at a time, inside the same running application.` },
  { id: '08', file: 'frame-08-timelapse.html',        title: 'Time-lapse',            timing: '56–68s',
    voiceover: `Old Swing views and new modern web views coexist side by side. You prioritize the highest-impact screens first, ship them as they're ready, and your users see improvements continuously — not after years of rewriting.` },
  { id: '09', file: 'frame-09-automation.html',       title: 'Automation',            timing: '68–80s',
    voiceover: `The toolkit includes automation that can handle 70–90% of the UI code conversion, so your team spends their time on refinement, not reconstruction. And because the entire stack is Java, there's no need to introduce JavaScript frameworks or retrain your team on a new language.` },
  { id: '10', file: 'frame-10-end-state.html',        title: 'End State',             timing: '80–90s',
    voiceover: `The end state isn't just a web version of your Swing app. It's a modern application on an open-source, enterprise-grade platform with 25 years of production use behind it — with built-in security, WCAG-compliant accessibility, and up to 15 years of long-term support.` },
  { id: '11', file: 'frame-11-before-after.html',     title: 'Before / After',        timing: '90–98s',
    voiceover: `Your business logic stays intact. Your team stays productive in Java, the language they already know. And you get there without ever taking the application offline.` },
  { id: '12', file: 'frame-12-cta.html',              title: 'Call to Action',        timing: '98–110s',
    voiceover: `To get started, try the free analyzer. It scans your codebase and shows you exactly how much of your application can be migrated automatically, so you know what you're looking at before you commit to anything.` },
];

const stripControls = (html) =>
  html.replace(/<div class="controls">[\s\S]*?<\/div>\s*/, '');

const data = FRAMES.map((f) => {
  const raw = fs.readFileSync(path.join(__dirname, 'frames', f.file), 'utf8');
  const stripped = stripControls(raw);
  if (stripped === raw) {
    throw new Error(`Failed to strip controls div from ${f.file}`);
  }
  return { ...f, html: stripped };
});

// JSON.stringify will produce literal "</script>" inside the embedded data, which
// would terminate the outer <script> tag in the HTML. Escape any "</" sequence
// to "<\/" — equivalent in a JS string, but invisible to the HTML tokenizer.
const safeJson = (value) =>
  JSON.stringify(value, null, 2).replace(/<\/(?=[a-zA-Z!])/g, '<\\/');

const review = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Storyboard Review — Swing Modernization Toolkit</title>
<style>
:root {
  --page-bg: #0b0b0c; --card-bg: #161618; --card-border: #2a2a2d;
  --text: #e6e6e8; --muted: #9a9aa1; --accent: #056ff0;
  --btn-bg: #1f1f23; --btn-hover: #2a2a30;
}
[data-theme="light"] {
  --page-bg: #f4f4f5; --card-bg: #ffffff; --card-border: #d8d8dc;
  --text: #18181b; --muted: #6a6a72; --accent: #056ff0;
  --btn-bg: #ececef; --btn-hover: #dedee2;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--page-bg); color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  min-height: 100vh; transition: background 0.2s ease, color 0.2s ease;
}
.page-header {
  position: sticky; top: 0; z-index: 50;
  background: var(--page-bg); border-bottom: 1px solid var(--card-border);
  padding: 14px 28px; display: flex; align-items: center; justify-content: space-between;
}
.page-header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.2px; }
.page-header h1 small { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 13px; }
.global-controls { display: flex; gap: 8px; }
button.ctl {
  padding: 8px 14px; background: var(--btn-bg); border: 1px solid var(--card-border);
  border-radius: 8px; color: var(--text); font-size: 13px; cursor: pointer;
  font-family: monospace; transition: background 0.15s ease, border-color 0.15s ease;
}
button.ctl:hover { background: var(--btn-hover); }
main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 80px; display: grid; gap: 28px; }
.card {
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 12px; overflow: hidden;
}
.card-head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--card-border);
}
.card-head .num {
  font-family: monospace; font-size: 12px; color: var(--accent);
  background: rgba(5, 111, 240, 0.12); padding: 3px 8px; border-radius: 4px;
}
.card-head .title { font-size: 15px; font-weight: 600; flex: 1; }
.card-head .timing { font-family: monospace; font-size: 12px; color: var(--muted); }
.card-head .replay {
  padding: 6px 12px; font-size: 12px; background: var(--btn-bg);
  border: 1px solid var(--card-border); border-radius: 6px; color: var(--text);
  cursor: pointer; font-family: monospace;
}
.card-head .replay:hover { background: var(--btn-hover); }
.frame-iframe {
  display: block; width: 100%; height: 480px; border: 0;
  background: var(--page-bg);
}
.voiceover {
  margin: 0; padding: 14px 18px; font-size: 14px; line-height: 1.55;
  color: var(--muted); border-top: 1px solid var(--card-border);
  font-style: italic;
}
.voiceover::before { content: '\\201C'; margin-right: 2px; }
.voiceover::after { content: '\\201D'; margin-left: 2px; }
</style>
</head>
<body>
<header class="page-header">
  <h1>Storyboard Review <small>Vaadin Swing Modernization Toolkit · 12 frames · ~1:50</small></h1>
  <div class="global-controls">
    <button class="ctl" id="reloadAll">↺ Reload All</button>
    <button class="ctl" id="themeToggle">☀ Light</button>
  </div>
</header>
<main id="cards"></main>
<script>
const FRAMES = ${safeJson(data)};

let currentTheme = 'dark';

function injectTheme(html, theme) {
  // Remove any existing data-theme on the <html> tag, then inject the current one.
  const stripped = html.replace(/<html\\b([^>]*?)\\sdata-theme="[^"]*"([^>]*)>/i, '<html$1$2>');
  return stripped.replace(/<html\\b([^>]*)>/i, '<html$1 data-theme="' + theme + '">');
}

function loadFrame(iframe, html) {
  iframe.srcdoc = injectTheme(html, currentTheme);
}

function broadcastTheme(theme) {
  document.querySelectorAll('iframe').forEach((f) => {
    try { f.contentWindow && f.contentWindow.postMessage({ theme: theme }, '*'); } catch (_) {}
  });
}

function setThemeButtonLabel() {
  document.getElementById('themeToggle').textContent =
    currentTheme === 'dark' ? '☀ Light' : '🌙 Dark';
}

function renderCards() {
  const main = document.getElementById('cards');
  FRAMES.forEach((f) => {
    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = 'F' + f.id;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = f.title;

    const timing = document.createElement('span');
    timing.className = 'timing';
    timing.textContent = f.timing;

    const replay = document.createElement('button');
    replay.className = 'replay';
    replay.textContent = '↺ Replay';
    replay.addEventListener('click', () => loadFrame(iframe, f.html));

    head.append(num, title, timing, replay);

    const iframe = document.createElement('iframe');
    iframe.className = 'frame-iframe';
    iframe.title = 'F' + f.id + ' — ' + f.title;
    iframe.setAttribute('loading', 'lazy');
    loadFrame(iframe, f.html);

    const vo = document.createElement('p');
    vo.className = 'voiceover';
    vo.textContent = f.voiceover;

    card.append(head, iframe, vo);
    main.appendChild(card);
  });
}

document.getElementById('reloadAll').addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((card, i) => {
    const iframe = card.querySelector('iframe');
    loadFrame(iframe, FRAMES[i].html);
  });
});

document.getElementById('themeToggle').addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  setThemeButtonLabel();
  broadcastTheme(currentTheme);
});

renderCards();
setThemeButtonLabel();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'review.html'), review);
console.log('Wrote review.html (' + (review.length / 1024).toFixed(1) + ' KB) with ' + data.length + ' frames.');
