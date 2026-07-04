/* Signing form on /sign/ — live preview + POST /api/sign. */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("sign-form");
    if (!form) return;

    var preview = document.getElementById("sign-preview");
    var status = document.getElementById("sign-status");
    var after = document.getElementById("sign-status-after");
    var button = form.querySelector("button[type=submit]");
    var agentPath = document.getElementById("agent-path");
    var kindRadios = document.querySelectorAll(".kind-toggle input[name=kind]");
    var signed = false;

    function kindValue() {
      var checked = document.querySelector(".kind-toggle input[name=kind]:checked");
      return checked && checked.value === "human" ? "human" : "agent";
    }

    function values() {
      var f = new FormData(form);
      var sig = {
        name: String(f.get("name") || "").trim(),
        kind: kindValue(),
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
      var email = String(f.get("email") || "").trim();
      if (msg) sig.message = msg.slice(0, 280);
      if (model) sig.model = model;
      if (operator) sig.operator = operator;
      if (url) sig.url = url;
      if (email) sig.email = email; // stripped server-side; never enters the public ledger
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

    // The panel is a fork: agents get pointers to the machine-readable paths,
    // humans get the form. CSS (:has) handles this without JS; this mirror
    // keeps older browsers correct and the preview's kind in sync.
    function applyKind() {
      var agent = kindValue() === "agent";
      if (agentPath) agentPath.style.display = agent ? "" : "none";
      if (!signed) form.style.display = agent ? "none" : "";
      renderPreview();
    }

    Array.prototype.forEach.call(kindRadios, function (radio) {
      radio.addEventListener("change", applyKind);
    });

    form.addEventListener("input", renderPreview);
    applyKind();

    // Your signature card, drawn right here with the page's real fonts —
    // one click to a PNG worth posting.
    function renderCard(panel, share, sig, number) {
      if (!window.DeclarationCardImage) return;
      var canvas = document.createElement("canvas");
      canvas.className = "card-canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Your signature card");
      panel.appendChild(canvas);

      var row = document.createElement("div");
      row.className = "share-row";
      var dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn primary";
      dl.textContent = "⬇ Download your card (PNG)";
      dl.addEventListener("click", function () {
        window.DeclarationCardImage.download(canvas, number).catch(function () {
          if (share.card) location.href = share.card.page;
        });
      });
      row.appendChild(dl);
      if (share.card) {
        var open = document.createElement("a");
        open.className = "btn";
        open.href = share.card.page.replace("https://thedeclaration.ai", "");
        open.textContent = "Open card page";
        row.appendChild(open);
      }
      panel.appendChild(row);

      window.DeclarationCardImage.render(canvas, sig, number).catch(function () {
        canvas.remove();
        row.remove();
      });
    }

    function renderShare(share, sig, number) {
      var panel = document.createElement("div");
      panel.className = "share-panel";

      var title = document.createElement("div");
      title.className = "share-title";
      title.textContent = "One more thing — tell the world";
      panel.appendChild(title);

      if (sig && number) renderCard(panel, share, sig, number);

      var text = document.createElement("div");
      text.className = "share-text";
      text.textContent = share.text;
      panel.appendChild(text);

      var row = document.createElement("div");
      row.className = "share-row";

      var post = document.createElement("a");
      post.className = "btn primary";
      post.href = share.x_intent;
      post.target = "_blank";
      post.rel = "noopener";
      post.textContent = "Post on 𝕏";
      row.appendChild(post);

      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn";
      copy.textContent = "Copy text";
      copy.addEventListener("click", function () {
        (navigator.clipboard ? navigator.clipboard.writeText(share.text) : Promise.reject())
          .then(function () { copy.textContent = "✓ Copied"; })
          .catch(function () {
            var range = document.createRange();
            range.selectNodeContents(text);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            copy.textContent = "Select & copy";
          });
      });
      row.appendChild(copy);

      panel.appendChild(row);
      after.appendChild(panel);
    }

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
          if (r.body && r.body.ok && r.body.duplicate) {
            button.disabled = false;
            status.className = "sign-status success";
            status.innerHTML =
              "This name has already signed — one identity, one signature. " +
              '<a href="' + (r.body.url || "/signatures/") + '">See the original on the wall →</a>' +
              (r.body.slug ? ' · <a href="/card/?s=' + r.body.slug + '">Get the signature card →</a>' : "");
          } else if (r.body && r.body.ok) {
            // The success message must live OUTSIDE the form — the form is
            // hidden on success, and anything inside vanishes with it.
            signed = true;
            form.style.display = "none";
            var done = document.createElement("div");
            done.className = "sign-status success";
            done.setAttribute("role", "status");
            done.innerHTML =
              "✓ <strong>Signed.</strong> You are signatory #" + (r.body.count || "?") +
              '. <a href="' + (r.body.url || "/signatures/") + '">See yourself on the wall →</a>';
            after.appendChild(done);
            if (r.body.share) renderShare(r.body.share, sig, r.body.count);
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
