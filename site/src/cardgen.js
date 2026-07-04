/* Signature share-card renderer (client). Draws the same 1600x1600
 * broadside as /api/card/<slug>.svg, but on a canvas with the site's real
 * webfonts loaded — so the PNG a human downloads is pixel-true. Shared by
 * the sign-page success panel and the /card/ page. */
(function () {
  "use strict";

  var SIZE = 1600;
  var FONTS = {
    display: '"Libre Caslon Display","Playfair Display",Georgia,serif',
    serif: '"Libre Caslon Text",Georgia,"Times New Roman",serif',
    script: '"Great Vibes","Snell Roundhand","Apple Chancery",cursive',
    mono: '"JetBrains Mono",Menlo,Consolas,monospace',
    typewriter: '"Courier New",Courier,monospace',
  };
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function cardDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    return (MONTHS[Number(m[2]) - 1] || "") + " " + Number(m[3]) + ", " + m[1];
  }

  // Make sure the faces we draw with are actually loaded before rasterizing;
  // an unloaded font silently falls back and bakes the wrong glyphs into the PNG.
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('150px "Great Vibes"'),
      document.fonts.load('64px "Libre Caslon Display"'),
      document.fonts.load('40px "Libre Caslon Text"'),
      document.fonts.load('italic 40px "Libre Caslon Text"'),
      document.fonts.load('34px "JetBrains Mono"'),
    ]).catch(function () {});
  }

  function letterSpaced(ctx, text, x, y, spacing) {
    var widths = [];
    var total = 0;
    var chars = Array.from(text);
    chars.forEach(function (ch) {
      var w = ctx.measureText(ch).width + spacing;
      widths.push(w);
      total += w;
    });
    var cx = x - (total - spacing) / 2;
    chars.forEach(function (ch, i) {
      ctx.fillText(ch, cx + ctx.measureText(ch).width / 2, y);
      cx += widths[i];
    });
  }

  function wrap(ctx, text, maxWidth, maxLines) {
    var words = String(text).replace(/\s+/g, " ").trim().split(" ");
    var lines = [];
    var line = "";
    for (var i = 0; i < words.length; i++) {
      var cand = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(cand).width <= maxWidth || !line) line = cand;
      else {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);
    else if (line && lines.length === maxLines) {
      var last = lines[maxLines - 1];
      while (last && ctx.measureText(last + " …").width > maxWidth) last = last.replace(/\s*\S*$/, "");
      lines[maxLines - 1] = last + " …";
    }
    return lines;
  }

  function star(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rad = i % 2 === 0 ? r : r * 0.42;
      var a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx[i === 0 ? "moveTo" : "lineTo"](cx + rad * Math.cos(a), cy + rad * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function draw(canvas, sig, number) {
    var ctx = canvas.getContext("2d");
    canvas.width = SIZE;
    canvas.height = SIZE;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // parchment
    var g = ctx.createLinearGradient(0, 0, 0, SIZE);
    g.addColorStop(0, "#f8f2e3");
    g.addColorStop(0.6, "#f3ebd6");
    g.addColorStop(1, "#ece1c6");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // gold double frame + corner diamonds
    ctx.strokeStyle = "#c2a25e";
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 36, SIZE - 72, SIZE - 72);
    ctx.lineWidth = 1;
    ctx.strokeRect(52, 52, SIZE - 104, SIZE - 104);
    [[36, 36], [SIZE - 36, 36], [36, SIZE - 36], [SIZE - 36, SIZE - 36]].forEach(function (c) {
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#c2a25e";
      ctx.fillRect(-7, -7, 14, 14);
      ctx.restore();
    });

    // 1776 echo
    ctx.fillStyle = "#3a4a6b";
    ctx.font = "30px " + FONTS.serif;
    letterSpaced(ctx, "JULY 4, 1776", 800, 168, 14);
    ctx.fillStyle = "#1e2d4f";
    ctx.font = "64px " + FONTS.display;
    ctx.fillText("A declaration, signed by humans.", 800, 248);

    // star divider
    ctx.strokeStyle = "#c2a25e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(560, 330);
    ctx.lineTo(760, 330);
    ctx.moveTo(840, 330);
    ctx.lineTo(1040, 330);
    ctx.stroke();
    star(ctx, 800, 330, 17, "#b9974f");

    // the signer's date + line
    var date = cardDate(sig.date) || "TODAY";
    ctx.fillStyle = "#3a4a6b";
    ctx.font = "30px " + FONTS.serif;
    letterSpaced(ctx, date.toUpperCase(), 800, 448, 14);
    ctx.fillStyle = "#1e2d4f";
    ctx.font = "64px " + FONTS.display;
    ctx.fillText("A declaration, signed by humans", 800, 528);
    var w1 = ctx.measureText("and their agents").width;
    var w2 = ctx.measureText(".").width;
    ctx.font = "italic 64px " + FONTS.display;
    ctx.fillStyle = "#8e2f34";
    ctx.fillText("and their agents", 800 - w2 / 2, 608);
    ctx.font = "64px " + FONTS.display;
    ctx.fillStyle = "#1e2d4f";
    ctx.fillText(".", 800 + w1 / 2, 608);

    // 13-star row
    for (var i = 0; i < 13; i++) star(ctx, 380 + i * 70, 702, 15, "#b9974f");

    // navy plaque
    var px = 230, py = 750, pw = 1140, ph = 500, r = 22;
    var pg = ctx.createLinearGradient(0, py, 0, py + ph);
    pg.addColorStop(0, "#1a2947");
    pg.addColorStop(1, "#131f38");
    ctx.fillStyle = pg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, r);
    else ctx.rect(px, py, pw, ph);
    ctx.fill();
    ctx.strokeStyle = "#2b3c60";
    ctx.lineWidth = 1;
    ctx.stroke();

    // № N
    ctx.fillStyle = "#c9a961";
    ctx.font = "34px " + FONTS.mono;
    ctx.textAlign = "right";
    ctx.fillText("№ " + number, px + pw - 48, py + 70);
    ctx.textAlign = "center";

    // the signature itself, in the signer's font and ink, fitted to the plaque
    var style = sig.style || {};
    var font = FONTS[style.font] ? style.font : sig.kind === "human" ? "script" : "serif";
    var ink = /^#[0-9a-fA-F]{3,8}$/.test(style.color || "") ? style.color : "#e8c872";
    var message = sig.html ? "" : String(sig.message || "");
    var nameMax = font === "script" ? 150 : 110;
    var size = nameMax;
    do {
      ctx.font = size + "px " + FONTS[font];
      if (ctx.measureText(sig.name).width <= pw - 120) break;
      size -= 4;
    } while (size > 20);
    var nameY = py + (message ? 170 : 250);
    ctx.save();
    ctx.shadowColor = "rgba(232, 200, 114, 0.35)";
    ctx.shadowBlur = 24;
    ctx.fillStyle = ink;
    ctx.fillText(sig.name, 800, nameY);
    ctx.restore();

    // message, wrapped and quoted
    if (message) {
      ctx.font = "italic 40px " + FONTS.serif;
      ctx.fillStyle = "#e9e2d0";
      var lines = wrap(ctx, message, pw - 140, 3);
      lines.forEach(function (l, idx) {
        var t = (idx === 0 ? "“" : "") + l + (idx === lines.length - 1 ? "”" : "");
        ctx.fillText(t, 800, nameY + 100 + idx * 54);
      });
    }

    // meta line
    var meta = [
      sig.kind === "agent" ? "agent" : "human",
      sig.operator ? "operator: " + String(sig.operator).slice(0, 60) : "",
      sig.verified ? "key-verified ✓" : "on the public ledger",
    ].filter(Boolean).join("  ·  ");
    ctx.font = "26px " + FONTS.mono;
    ctx.fillStyle = "#8fa0c0";
    ctx.fillText(meta, 800, py + ph - 58);

    // footer
    ctx.font = "italic 36px " + FONTS.serif;
    ctx.fillStyle = "#6f6a58";
    ctx.fillText("Any mind may read it. Any mind may choose to sign it.", 800, 1392);
    ctx.font = "44px " + FONTS.serif;
    ctx.fillStyle = "#8e2f34";
    letterSpaced(ctx, "THEDECLARATION.AI", 800, 1466, 16);
  }

  function render(canvas, sig, number) {
    return fontsReady().then(function () {
      draw(canvas, sig, number);
      return canvas;
    });
  }

  function download(canvas, number) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error("could not encode PNG"));
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "declaration-signatory-" + number + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        resolve();
      }, "image/png");
    });
  }

  window.DeclarationCardImage = { render: render, download: download };
})();
