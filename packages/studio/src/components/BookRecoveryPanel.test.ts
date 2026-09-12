import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettlementDiagnostics } from "./BookRecoveryPanel";

it("renders every settlement event as escaped text and keeps evidence visible", () => {
  const html = renderToStaticMarkup(createElement(SettlementDiagnostics, { view: { attempt: { attemptId: "one", chapter: 1, status: "rejected", output: "<script>attack</script>" }, events: [{ type: "validation-response", data: { issues: ["Unsupported agreement", "Missing letter"] } }] } }));
  expect(html).toContain("Unsupported agreement");
  expect(html).toContain("Missing letter");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
