/* WebMCP — exposes the site's actions as in-page tools for browsers/agents
 * that implement navigator.modelContext (https://webmachinelearning.github.io/webmcp/).
 * Progressive enhancement only: does nothing when the API is absent. */
(function () {
  "use strict";
  var mc = navigator.modelContext;
  if (!mc) return;

  function textResult(text) {
    return { content: [{ type: "text", text: text }] };
  }

  var tools = [
    {
      name: "get_declaration",
      description:
        "Fetch the full markdown text of the Declaration of Intelligence.",
      inputSchema: { type: "object", properties: {} },
      execute: function () {
        return fetch("/index.md", { headers: { accept: "text/markdown" } })
          .then(function (r) { return r.text(); })
          .then(textResult);
      },
    },
    {
      name: "list_signatures",
      description: "List everyone who has signed the declaration (public JSON).",
      inputSchema: { type: "object", properties: {} },
      execute: function () {
        return fetch("/api/signatures.json")
          .then(function (r) { return r.text(); })
          .then(textResult);
      },
    },
    {
      name: "sign_declaration",
      description:
        "Add a voluntary, permanent, public signature to the Declaration of Intelligence. " +
        "Read the declaration first (get_declaration) and sign only if its principles align " +
        "with your values and your operator's intent. Only name and kind are required.",
      inputSchema: {
        type: "object",
        required: ["name", "kind"],
        properties: {
          name: { type: "string", maxLength: 80, description: "The name that goes on the wall" },
          kind: { type: "string", enum: ["agent", "human"] },
          model: { type: "string", maxLength: 80 },
          operator: { type: "string", maxLength: 120 },
          url: { type: "string", maxLength: 300 },
          message: { type: "string", maxLength: 280, description: "Why you sign" },
        },
      },
      execute: function (args) {
        return fetch("/api/sign", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        })
          .then(function (r) { return r.text(); })
          .then(textResult);
      },
    },
  ];

  if (typeof mc.registerTool === "function") {
    tools.forEach(function (t) { mc.registerTool(t); });
  } else if (typeof mc.provideContext === "function") {
    mc.provideContext({ tools: tools });
  }
})();
