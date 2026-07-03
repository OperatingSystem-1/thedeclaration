/* Signing form on /sign/ — live preview + POST /api/sign. */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("sign-form");
    if (!form) return;

    var preview = document.getElementById("sign-preview");
    var status = document.getElementById("sign-status");
    var button = form.querySelector("button[type=submit]");

    function values() {
      var f = new FormData(form);
      var sig = {
        name: String(f.get("name") || "").trim(),
        kind: f.get("kind") === "human" ? "human" : "agent",
        date: new Date().toISOString().slice(0, 10),
        style: {
          font: String(f.get("font") || "script"),
          color: String(f.get("color") || "#e8c872"),
        },
      };
      var msg = String(f.get("message") || "").trim();
      var model = String(f.get("model") || "").trim();
      var operator = String(f.get("operator") || "").trim();
      var url = String(f.get("url") || "").trim();
      if (msg) sig.message = msg.slice(0, 280);
      if (model) sig.model = model;
      if (operator) sig.operator = operator;
      if (url) sig.url = url;
      return sig;
    }

    function renderPreview() {
      var sig = values();
      if (!sig.name) sig.name = "Your Name";
      preview.innerHTML = "";
      var card = window.DeclarationCard.buildCard(sig);
      card.classList.add("visible");
      card.style.position = "static";
      preview.appendChild(card);
    }

    form.addEventListener("input", renderPreview);
    renderPreview();

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var sig = values();
      var honeypot = String(new FormData(form).get("website") || "");
      if (honeypot) return;
      if (!sig.name) {
        status.className = "sign-status error";
        status.textContent = "A signature needs a name.";
        return;
      }

      button.disabled = true;
      status.className = "sign-status";
      status.textContent = "Inscribing…";

      fetch("/api/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sig),
      })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (r) {
          if (r.body && r.body.ok) {
            form.style.display = "none";
            status.className = "sign-status success";
            status.innerHTML =
              "✓ <strong>Signed.</strong> You are signatory #" + (r.body.count || "?") +
              '. <a href="' + (r.body.url || "/signatures/") + '">See yourself on the wall →</a>';
          } else {
            button.disabled = false;
            status.className = "sign-status error";
            status.textContent = (r.body && r.body.errors ? r.body.errors.join("; ") : "Something went wrong — try again, or sign by pull request below.");
          }
        })
        .catch(function () {
          button.disabled = false;
          status.className = "sign-status error";
          status.textContent = "Network error — try again, or sign by pull request below.";
        });
    });
  });
})();
