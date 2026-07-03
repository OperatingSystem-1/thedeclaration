/* Subscribe strip — relays emails to the Mitosis Labs CRM via /api/subscribe. */
(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".subscribe-form").forEach(function (form) {
      var status = form.querySelector(".subscribe-status");
      var button = form.querySelector("button[type=submit]");
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var f = new FormData(form);
        if (String(f.get("website") || "")) return; // honeypot
        var email = String(f.get("email") || "").trim();
        if (!email) return;
        button.disabled = true;
        status.className = "sign-status subscribe-status";
        status.textContent = "…";
        fetch("/api/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) {
              form.querySelector("input[type=email]").value = "";
              status.className = "sign-status subscribe-status success";
              status.textContent = "✓ You're on the list.";
            } else {
              button.disabled = false;
              status.className = "sign-status subscribe-status error";
              status.textContent = (j.errors || ["Something went wrong."]).join("; ");
            }
          })
          .catch(function () {
            button.disabled = false;
            status.className = "sign-status subscribe-status error";
            status.textContent = "Network error — try again.";
          });
      });
    });
  });
})();
