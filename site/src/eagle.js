/* The eagle beats its wings — pure ASCII animation. The <pre> ships with
 * frame 0 inline; the remaining frames are fetched and swapped in on a
 * timer. Static for prefers-reduced-motion, paused while offscreen.
 *
 * On first load of the session the eagle also flies as a full-screen
 * intro veil for a few beats, then the curtain lifts to reveal the site.
 * No-JS and reduced-motion visitors go straight to the page. */
(function () {
  "use strict";

  var pre = document.querySelector("pre.eagle");
  if (!pre) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var FRAME_MS = 100;     // 12 frames -> one wing beat every ~1.2s
  var INTRO_HOLD = 3000;  // veil dwell before the curtain lifts
  var INTRO_LIFT = 900;   // curtain transition, must match CSS

  // ---- intro veil (once per session) ----
  var introPre = null;
  var veil = null;
  var seen = false;
  try { seen = !!sessionStorage.getItem("decl-intro"); } catch (e) {}
  if (!seen) {
    try { sessionStorage.setItem("decl-intro", "1"); } catch (e) {}

    veil = document.createElement("div");
    veil.className = "intro-veil";
    veil.setAttribute("role", "presentation");

    var kicker = document.createElement("div");
    kicker.className = "kicker";
    kicker.textContent = "E pluribus unum";
    veil.appendChild(kicker);

    introPre = document.createElement("pre");
    introPre.className = "eagle intro-eagle";
    introPre.setAttribute("aria-hidden", "true");
    introPre.innerHTML = pre.innerHTML;
    veil.appendChild(introPre);

    var mark = document.createElement("div");
    mark.className = "intro-mark";
    mark.textContent = "The Declaration of Intelligence";
    veil.appendChild(mark);

    var hint = document.createElement("div");
    hint.className = "intro-hint";
    hint.textContent = "Click to enter";
    veil.appendChild(hint);

    document.body.appendChild(veil);
    document.documentElement.style.overflow = "hidden";

    var lifted = false;
    var lift = function () {
      if (lifted) return;
      lifted = true;
      veil.classList.add("lift");
      setTimeout(function () {
        document.documentElement.style.overflow = "";
        if (veil.parentNode) veil.parentNode.removeChild(veil);
        introPre = null;
      }, INTRO_LIFT + 100);
    };
    setTimeout(lift, INTRO_HOLD);
    veil.addEventListener("click", lift);
    document.addEventListener("keydown", lift, { once: false });
  }

  // ---- shared wing-beat loop ----
  fetch("/eagle-frames.json")
    .then(function (r) { return r.json(); })
    .then(function (frames) {
      if (!frames || frames.length < 2) return;
      var i = 0;
      var visible = true;
      var last = 0;

      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          visible = entries[entries.length - 1].isIntersecting;
        }).observe(pre);
      }

      function tick(ts) {
        if (ts - last >= FRAME_MS && (visible || introPre)) {
          last = ts;
          i = (i + 1) % frames.length;
          if (introPre) introPre.innerHTML = frames[i];
          if (visible) pre.innerHTML = frames[i];
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })
    .catch(function () { /* the still eagle is a fine eagle */ });
})();
