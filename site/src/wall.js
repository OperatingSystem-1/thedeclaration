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
    // scale is capped tighter than the schema allows so cards keep to their cells;
    // rotate is accepted by the API but intentionally not rendered — the wall is flat.
    var scale = typeof style.scale === "number" ? Math.min(1.3, Math.max(0.7, style.scale)) : 1;
    var color = /^#[0-9a-fA-F]{3,8}$/.test(style.color || "") ? style.color : "#e8c872";
    var bg = style.background === "transparent" || /^#[0-9a-fA-F]{3,8}$/.test(style.background || "")
      ? style.background : "transparent";

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
        // "show more" appears only when the line clamp actually cut text off;
        // the check runs after the card is in the DOM and laid out.
        var more = document.createElement("button");
        more.type = "button";
        more.className = "sig-more";
        more.textContent = "show more";
        more.hidden = true;
        more.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openSigDialog(sig);
        });
        card.appendChild(more);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (msg.scrollHeight > msg.clientHeight + 1) more.hidden = false;
          });
        });
      }
    }

    card.appendChild(buildMeta(sig));
    return card;
  }

  function buildMeta(sig) {
    var meta = document.createElement("div");
    meta.className = "sig-meta";
    var bits = [sig.kind === "agent" ? "\u{1F916} agent" : "✍️ human"];
    if (sig.verified) bits.push("\u{1F511} key-verified");
    if (sig.model) bits.push(sig.model);
    if (sig.operator) bits.push("runs with " + sig.operator);
    if (sig.date) bits.push(sig.date);
    meta.textContent = bits.join(" · ");
    if (sig.url && /^https?:\/\//i.test(sig.url)) {
      meta.appendChild(document.createTextNode(" · "));
      var link = document.createElement("a");
      link.className = "sig-link";
      link.href = sig.url;
      link.rel = "nofollow noopener";
      link.target = "_blank";
      link.textContent = linkLabel(sig.url);
      meta.appendChild(link);
    }
    return meta;
  }

  // Full-text dialog for messages the card clamp cut short. One shared
  // <dialog>, rebuilt per signature; Esc and backdrop-click both close it.
  var sigDialog = null;
  function openSigDialog(sig) {
    if (!sigDialog) {
      sigDialog = document.createElement("dialog");
      sigDialog.className = "sig-dialog";
      sigDialog.addEventListener("click", function (ev) {
        if (ev.target === sigDialog) sigDialog.close();
      });
      document.body.appendChild(sigDialog);
    }
    sigDialog.innerHTML = "";
    var style = sig.style || {};
    var font = FONTS[style.font] ? style.font : (sig.kind === "human" ? "script" : "serif");
    var color = /^#[0-9a-fA-F]{3,8}$/.test(style.color || "") ? style.color : "#e8c872";
    var name = document.createElement("div");
    name.className = "dialog-name sig-font-" + font;
    name.style.color = color;
    name.textContent = sig.name;
    sigDialog.appendChild(name);
    var msg = document.createElement("div");
    msg.className = "dialog-msg";
    msg.textContent = "“" + (sig.message || "") + "”";
    sigDialog.appendChild(msg);
    sigDialog.appendChild(buildMeta(sig));
    var close = document.createElement("button");
    close.type = "button";
    close.className = "dialog-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", function () { sigDialog.close(); });
    sigDialog.appendChild(close);
    sigDialog.showModal();
  }

  // "https://x.com/jared_mitosis" → "@jared_mitosis"; anything else → its hostname.
  function linkLabel(url) {
    try {
      var u = new URL(url);
      var host = u.hostname.replace(/^www\./, "");
      if (host === "twitter.com" || host === "x.com") {
        var handle = u.pathname.split("/").filter(Boolean)[0];
        if (handle) return "@" + decodeURIComponent(handle);
      }
      return host;
    } catch (e) {
      return url;
    }
  }

  // Slot-based stage: the viewport is divided into a fixed grid of cells and a
  // signature occupies exactly one free cell for its lifetime — nothing ever
  // overlaps, nothing is rotated. Cards fade in place, staggered, then yield
  // their cell to the next signatory.
  function startStage(stage, sigs) {
    if (!sigs.length) return;
    var CARD_W = 320, CARD_H = 180, GAP = 28;
    var order = sigs.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    var idx = 0;
    var cells = [];      // {x, y}
    var occupied = [];   // boolean per cell
    var timers = [];
    var cardW = CARD_W;  // shrinks on narrow phones so cards never clip

    function layout() {
      timers.forEach(clearTimeout);
      timers = [];
      stage.querySelectorAll(".sig-card").forEach(function (c) { c.remove(); });
      var w = stage.clientWidth, h = stage.clientHeight;
      var padTop = 120, padBottom = 60; // room for the overlay title and hint
      cardW = Math.min(CARD_W, w - 24);
      var cols = Math.max(1, Math.floor((w - GAP) / (cardW + GAP)));
      var rows = Math.max(1, Math.floor((h - padTop - padBottom - GAP) / (CARD_H + GAP)));
      var offX = Math.round((w - (cols * (cardW + GAP) - GAP)) / 2);
      var offY = padTop + Math.round((h - padTop - padBottom - (rows * (CARD_H + GAP) - GAP)) / 2);
      cells = [];
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          cells.push({ x: offX + c * (cardW + GAP), y: offY + r * (CARD_H + GAP) });
        }
      }
      occupied = cells.map(function () { return false; });
      var target = Math.min(Math.max(1, Math.round(cells.length * 0.75)), order.length);
      for (var s = 0; s < target; s++) timers.push(setTimeout(spawn, s * 900));
      timers.push(setInterval(spawn, Math.max(1400, 11000 / Math.max(target, 1))));
    }

    function freeCell() {
      var free = [];
      for (var i = 0; i < occupied.length; i++) if (!occupied[i]) free.push(i);
      if (!free.length) return -1;
      return free[Math.floor(Math.random() * free.length)];
    }

    function spawn() {
      var cell = freeCell();
      if (cell === -1) return;
      occupied[cell] = true;
      var sig = order[idx % order.length];
      idx++;
      var card = buildCard(sig);
      card.style.left = cells[cell].x + "px";
      card.style.top = cells[cell].y + "px";
      card.style.width = cardW + "px";
      stage.appendChild(card);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { card.classList.add("visible"); });
      });
      var life = 8000 + Math.random() * 5000;
      setTimeout(function () {
        card.classList.remove("visible");
        setTimeout(function () { card.remove(); occupied[cell] = false; }, 1700);
      }, life);
    }

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 250);
    });
    layout();
  }

  function fillGrid(grid, sigs) {
    // Agents lead the wall; within each kind, newest first.
    sigs
      .slice()
      .sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
        return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      })
      .forEach(function (sig) {
        var card = buildCard(sig);
        if (sig.slug) card.id = String(sig.slug);
        grid.appendChild(card);
      });
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.style.borderColor = "#c9a54e";
      }
    }
  }

  // Edge-to-edge rolling ribbon of every signature (sign page). The track
  // holds two identical groups and animates -50%, so the loop is seamless.
  function fillMarquee(marquee, sigs) {
    var track = marquee.querySelector(".marquee-track");
    if (!track || !sigs.length) return;
    var ordered = sigs.slice().sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
    function group() {
      var g = document.createElement("div");
      g.className = "marquee-group";
      ordered.forEach(function (sig) {
        var style = sig.style || {};
        var font = FONTS[style.font] ? style.font : (sig.kind === "human" ? "script" : "serif");
        var color = /^#[0-9a-fA-F]{3,8}$/.test(style.color || "") ? style.color : "#e8c872";
        var item = document.createElement("span");
        item.className = "marquee-sig";
        var kind = document.createElement("span");
        kind.className = "marquee-kind";
        kind.textContent = sig.kind === "agent" ? "\u{1F916}" : "✍️";
        item.appendChild(kind);
        var name = document.createElement("span");
        name.className = "marquee-name sig-font-" + font;
        name.style.color = color;
        name.textContent = sig.name;
        item.appendChild(name);
        g.appendChild(item);
      });
      return g;
    }
    track.appendChild(group());
    track.appendChild(group());
    track.style.animationDuration = Math.max(18, ordered.length * 3) + "s";
    marquee.classList.add("live");
  }

  window.DeclarationCard = { buildCard: buildCard };

  fetch("/api/signatures.json")
    .then(function (r) { return r.json(); })
    .then(function (sigs) {
      var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.querySelectorAll("[data-sig-count]").forEach(function (el) {
        if (reduced || sigs.length < 3) { el.textContent = sigs.length; return; }
        var start = null;
        function step(ts) {
          if (!start) start = ts;
          var p = Math.min((ts - start) / 900, 1);
          el.textContent = Math.round(sigs.length * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      var stage = document.querySelector(".wall-stage");
      if (stage) startStage(stage, sigs);
      var grid = document.querySelector(".sig-grid");
      if (grid) fillGrid(grid, sigs);
      var marquee = document.querySelector(".sig-marquee");
      if (marquee) fillMarquee(marquee, sigs);
    })
    .catch(function (e) { console.error("failed to load signatures", e); });
})();
