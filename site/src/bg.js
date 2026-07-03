/* Ambient neural-network background — slow-drifting nodes, linked when near.
 * Cheap to run; disabled for prefers-reduced-motion. */
(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var canvas = document.getElementById("bg-net");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var nodes = [];
  var W, H, COUNT;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    COUNT = Math.min(90, Math.max(36, Math.floor((W * H) / 26000)));
    while (nodes.length < COUNT) {
      nodes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: 0.8 + Math.random() * 1.6,
        hue: Math.random() < 0.75 ? "110,190,255" : "212,180,131",
      });
    }
    nodes.length = COUNT;
  }

  var LINK = 130;
  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.x += n.vx; n.y += n.vy;
      if (n.x < -20) n.x = W + 20; if (n.x > W + 20) n.x = -20;
      if (n.y < -20) n.y = H + 20; if (n.y > H + 20) n.y = -20;
    }
    for (var a = 0; a < nodes.length; a++) {
      for (var b = a + 1; b < nodes.length; b++) {
        var dx = nodes[a].x - nodes[b].x;
        var dy = nodes[a].y - nodes[b].y;
        var d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          var alpha = 0.10 * (1 - Math.sqrt(d2) / LINK);
          ctx.strokeStyle = "rgba(110,190,255," + alpha.toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodes[a].x, nodes[a].y);
          ctx.lineTo(nodes[b].x, nodes[b].y);
          ctx.stroke();
        }
      }
    }
    for (var k = 0; k < nodes.length; k++) {
      var p = nodes[k];
      ctx.fillStyle = "rgba(" + p.hue + ",0.5)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(tick);
})();
