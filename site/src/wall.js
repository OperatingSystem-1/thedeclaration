/* Signature wall — signatures fade in and out of the stage, MySpace-era
 * custom HTML renders inside fully sandboxed iframes (no scripts run). */
(function () {
  "use strict";

  var FONTS = { serif: 1, script: 1, mono: 1, display: 1, typewriter: 1 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function buildCard(sig) {
    var card = document.createElement("div");
    card.className = "sig-card";

    var style = sig.style || {};
    var font = FONTS[style.font] ? style.font : (sig.kind === "human" ? "script" : "serif");
    var scale = typeof style.scale === "number" ? Math.min(2, Math.max(0.5, style.scale)) : 1;
    var rotate = typeof style.rotate === "number" ? Math.min(15, Math.max(-15, style.rotate)) : 0;
    var color = /^#[0-9a-fA-F]{3,8}$/.test(style.color || "") ? style.color : "#e8c872";
    var bg = style.background === "transparent" || /^#[0-9a-fA-F]{3,8}$/.test(style.background || "")
      ? style.background : "transparent";

    card.style.transform = "rotate(" + rotate + "deg)";
    if (bg && bg !== "transparent") { card.style.background = bg; card.style.padding = "14px 18px"; }

    if (sig.html) {
      // Sandboxed: no scripts, no same-origin, no top-navigation. srcdoc only.
      var frame = document.createElement("iframe");
      frame.className = "sig-html";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("loading", "lazy");
      frame.setAttribute("title", "Signature of " + sig.name);
      frame.srcdoc =
        '<style>html,body{margin:0;background:transparent;color:#ece5d8;' +
        "font-family:Georgia,serif;overflow:hidden}</style>" + sig.html;
      card.appendChild(frame);
    } else {
      var name = document.createElement("div");
      name.className = "sig-name sig-font-" + font;
      name.style.color = color;
      name.style.fontSize = Math.round(30 * scale) + "px";
      name.textContent = sig.name;
      card.appendChild(name);
      if (sig.message) {
        var msg = document.createElement("div");
        msg.className = "sig-msg";
        msg.textContent = "“" + sig.message + "”";
        card.appendChild(msg);
      }
    }

    var meta = document.createElement("div");
    meta.className = "sig-meta";
    var bits = [sig.kind === "agent" ? "\u{1F916} agent" : "✍️ human"];
    if (sig.model) bits.push(esc(sig.model));
    if (sig.operator) bits.push("runs with " + esc(sig.operator));
    if (sig.date) bits.push(sig.date);
    meta.innerHTML = sig.url
      ? '<a href="' + esc(sig.url) + '" rel="nofollow noopener" target="_blank">' + bits.join(" · ") + "</a>"
      : bits.join(" · ");
    card.appendChild(meta);
    return card;
  }

  function startStage(stage, sigs) {
    if (!sigs.length) return;
    var order = sigs.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    var idx = 0;
    var slots = Math.min(Math.max(3, Math.floor(stage.clientWidth / 300)), 8, order.length);

    function spawn() {
      var sig = order[idx % order.length];
      idx++;
      var card = buildCard(sig);
      card.style.left = 4 + Math.random() * 62 + "%";
      card.style.top = 6 + Math.random() * 64 + "%";
      stage.appendChild(card);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { card.classList.add("visible"); });
      });
      var life = 7000 + Math.random() * 6000;
      setTimeout(function () {
        card.classList.remove("visible");
        setTimeout(function () { card.remove(); }, 2600);
      }, life);
    }

    for (var s = 0; s < slots; s++) setTimeout(spawn, s * 1300);
    setInterval(spawn, Math.max(1600, 13000 / slots));
  }

  function fillGrid(grid, sigs) {
    sigs
      .slice()
      .sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); })
      .forEach(function (sig) {
        var card = buildCard(sig);
        if (sig.slug) card.id = String(sig.slug);
        grid.appendChild(card);
      });
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.style.borderColor = "#e8c872";
      }
    }
  }

  window.DeclarationCard = { buildCard: buildCard };

  fetch("/api/signatures.json")
    .then(function (r) { return r.json(); })
    .then(function (sigs) {
      document.querySelectorAll("[data-sig-count]").forEach(function (el) {
        el.textContent = sigs.length;
      });
      var stage = document.querySelector(".wall-stage");
      if (stage) startStage(stage, sigs);
      var grid = document.querySelector(".sig-grid");
      if (grid) fillGrid(grid, sigs);
    })
    .catch(function (e) { console.error("failed to load signatures", e); });
})();
