/**
 * The one page that draws every card of the Dealflow Sales connector in the chat (sales-cards.ts). A chat app that supports MCP Apps
 * (io.modelcontextprotocol/ui, 2026-01-26) loads it in a sandboxed frame and passes it the tool's result; the page reads
 * `structuredContent.card` and draws it.
 *
 * It speaks the MCP Apps messages itself (ui/initialize, the tool result, ui/message, ui/open-link, size changes) instead of shipping the
 * SDK, loads nothing from outside, and sets every value as text, never as HTML; only http(s) links open. Colors follow the app (Venture OS
 * green on neutral) in light and dark, and yield to the chat app's own theme variables when it passes them.
 *
 * Written as String.raw so the script's backslashes stay as written; the script avoids backticks and template placeholders.
 */
export const CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dealflow Sales</title>
<style>
  :root {
    color-scheme: light dark;
    --ink: var(--color-text-primary, light-dark(#171a19, #f2f4f3));
    --soft: var(--color-text-secondary, light-dark(#5a615e, #b4bbb8));
    --line: var(--color-border-primary, light-dark(#e1e5e3, #343a37));
    --panel: var(--color-background-secondary, light-dark(#f6f8f7, #212624));
    --chip: light-dark(#eaeeec, #313734);
    --accent: light-dark(#188647, #4cc17b);
    --accent-ink: light-dark(#ffffff, #07170e);
    --accent-bg: light-dark(#e1f3e8, rgba(76, 193, 123, 0.16));
    --good: light-dark(#188647, #6fd09a);
    --good-bg: light-dark(#e1f3e8, rgba(111, 208, 154, 0.15));
    --warn: light-dark(#965800, #e6ac5c);
    --warn-bg: light-dark(#fbeed4, rgba(230, 172, 92, 0.15));
    --radius: var(--border-radius-lg, 14px);
    font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; color: var(--ink); }
  body { padding: 2px; font-size: 14px; line-height: 1.45; }
  .head h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
  .head p { margin: 3px 0 0; color: var(--soft); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .item { margin-top: 10px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .top h2 { margin: 0; font-size: 15px; font-weight: 650; min-width: 0; overflow-wrap: anywhere; }
  .meta { margin-top: 3px; color: var(--soft); font-size: 13px; }
  .chip { display: inline-block; padding: 3px 10px; border-radius: 999px; background: var(--chip); font-size: 12.5px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 550; }
  .good { color: var(--good); background: var(--good-bg); }
  .warn { color: var(--warn); background: var(--warn-bg); }
  .accent { color: var(--accent); background: var(--accent-bg); }
  .muted { color: var(--soft); background: var(--chip); }
  .quote { margin: 10px 0 0; padding-left: 10px; border-left: 3px solid var(--line); font-size: 13.5px; overflow-wrap: anywhere; }
  .lines { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--soft); }
  .lines li + li { margin-top: 3px; }
  .link { flex: none; margin-left: auto; border: 0; background: none; padding: 0; color: var(--accent); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button.act { min-height: 40px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 10px; background: transparent; color: var(--ink); font: inherit; font-size: 14px; font-weight: 550; cursor: pointer; }
  button.act:hover { border-color: var(--soft); }
  button.act.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.act:disabled { opacity: 0.6; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .arrow { margin-left: 4px; }
  .note { margin-top: 10px; color: var(--soft); font-size: 12.5px; }
  .say { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 10px; font-size: 12.5px; user-select: all; }
</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(function () {
  var root = document.getElementById("root");
  var nextId = 1;
  var pending = {};

  function post(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error("No answer from the chat")); }
      }, 20000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function resize() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    notify("ui/notifications/size-changed", { height: height });
  }

  function applyContext(context) {
    if (!context) return;
    if (context.theme === "light" || context.theme === "dark")
      document.documentElement.style.colorScheme = context.theme;
    var styles = context.styles || {};
    var variables = styles.variables || {};
    Object.keys(variables).forEach(function (name) {
      if (name.indexOf("--") === 0 && typeof variables[name] === "string")
        document.documentElement.style.setProperty(name, variables[name]);
    });
    if (styles.css && typeof styles.css.fonts === "string") {
      var fonts = document.createElement("style");
      fonts.textContent = styles.css.fonts;
      document.head.appendChild(fonts);
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function str(value) { return typeof value === "string" ? value : ""; }
  function list(value) { return Array.isArray(value) ? value : []; }
  function safeUrl(value) { return /^https?:\/\//i.test(str(value)) ? str(value) : ""; }
  var TONES = { good: 1, warn: 1, accent: 1, muted: 1 };

  function sayInstead(after, text) {
    var box = el("div", "say", "Say this in the chat: " + text);
    after.parentNode.insertBefore(box, after.nextSibling);
    resize();
  }

  function openLink(url, near) {
    request("ui/open-link", { url: url })
      .then(function (result) { if (result && result.isError) sayInstead(near, url); })
      .catch(function () { sayInstead(near, url); });
  }

  function act(action, button, row) {
    var url = safeUrl(action.open);
    if (url) { openLink(url, row); return; }
    var text = str(action.say);
    if (!text) return;
    button.disabled = true;
    request("ui/message", { role: "user", content: [{ type: "text", text: text }] })
      .then(function (result) {
        if (result && result.isError) throw new Error("refused");
        button.textContent = "Sent";
      })
      .catch(function () { button.disabled = false; sayInstead(row, text); });
  }

  function badges(parent, values) {
    var items = list(values).filter(function (b) { return b && str(b.text); });
    if (!items.length) return;
    var row = el("div", "row");
    items.forEach(function (b) {
      row.appendChild(el("span", "badge " + (TONES[b.tone] ? b.tone : "muted"), b.text));
    });
    parent.appendChild(row);
  }

  function actions(parent, values) {
    var items = list(values).filter(function (a) { return a && str(a.label) && (safeUrl(a.open) || str(a.say)); });
    if (!items.length) return;
    var row = el("div", "actions");
    items.forEach(function (a) {
      var button = el("button", "act" + (a.primary ? " primary" : ""), a.label);
      button.type = "button";
      if (safeUrl(a.open)) {
        var arrow = el("span", "arrow", "↗");
        arrow.setAttribute("aria-hidden", "true");
        button.appendChild(arrow);
      }
      button.addEventListener("click", function () { act(a, button, row); });
      row.appendChild(button);
    });
    parent.appendChild(row);
  }

  function item(data) {
    var box = el("section", "item");
    var top = el("div", "top");
    if (str(data.title)) top.appendChild(el("h2", null, data.title));
    var link = data.link && safeUrl(data.link.url);
    if (link) {
      var go = el("button", "link", str(data.link.label) || link);
      go.type = "button";
      var arrow = el("span", "arrow", "↗");
      arrow.setAttribute("aria-hidden", "true");
      go.appendChild(arrow);
      go.addEventListener("click", function () { openLink(link, box.lastChild || box); });
      top.appendChild(go);
    }
    if (top.childNodes.length) box.appendChild(top);
    if (str(data.meta)) box.appendChild(el("div", "meta", data.meta));
    var chips = list(data.chips).filter(function (c) { return str(c); });
    if (chips.length) {
      var row = el("div", "row");
      chips.forEach(function (c) { row.appendChild(el("span", "chip", c)); });
      box.appendChild(row);
    }
    badges(box, data.badges);
    if (str(data.quote)) box.appendChild(el("p", "quote", data.quote));
    var lines = list(data.lines).filter(function (l) { return str(l); });
    if (lines.length) {
      var ul = el("ul", "lines");
      lines.forEach(function (l) { ul.appendChild(el("li", null, l)); });
      box.appendChild(ul);
    }
    actions(box, data.actions);
    return box;
  }

  function draw(card) {
    root.textContent = "";
    var head = el("header", "head");
    if (str(card.title)) head.appendChild(el("h1", null, card.title));
    if (str(card.subtitle)) head.appendChild(el("p", null, card.subtitle));
    badges(head, card.badges);
    root.appendChild(head);
    list(card.items).forEach(function (data) { if (data) root.appendChild(item(data)); });
    if (str(card.note)) root.appendChild(el("p", "note", card.note));
    actions(root, card.actions);
    resize();
  }

  // Without a card (an older result, or an error), show the one line it says.
  function fallback(result) {
    var text = "";
    list(result.content).some(function (block) {
      if (block && block.type === "text" && str(block.text)) { text = block.text; return true; }
      return false;
    });
    if (!text) return null;
    try {
      var body = JSON.parse(text);
      if (body && str(body.say)) return { title: body.say.split("\n")[0] };
    } catch (e) {
      return { title: text.replace(/^Error:\s*/, "").slice(0, 300), badges: [{ text: "Not done", tone: "warn" }] };
    }
    return null;
  }

  function render(result) {
    var card = result && result.structuredContent && result.structuredContent.card;
    if (!card) card = fallback(result || {});
    if (!card) { root.textContent = ""; resize(); return; }
    draw(card);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id != null) {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) waiting.reject(new Error(message.error.message || "Refused"));
      else waiting.resolve(message.result || {});
      return;
    }
    if (message.method === "ui/notifications/tool-result") { render(message.params); return; }
    if (message.method === "ui/notifications/host-context-changed") { applyContext(message.params); return; }
    // A request from the chat app (a ping, or closing the card): acknowledge it.
    if (message.id != null) post({ jsonrpc: "2.0", id: message.id, result: {} });
  });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

  request("ui/initialize", {
    appInfo: { name: "dealflow-sales-card", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    applyContext(result.hostContext);
    notify("ui/notifications/initialized", {});
    resize();
  }).catch(function () {});
})();
</script>
</body>
</html>
`;
