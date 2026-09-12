import { expect, test } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withBookTransaction } from "../../core/dist/state/book-transaction.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createSettlementAttempt, appendSettlementEvent } from "../../core/dist/pipeline/settlement-attempt.js";

// Run against an actual Studio server pointed at this dedicated synthetic root.
// The Windows runner in temp/recovery-browser sets the same root for the server.
const root = process.env.INKOS_RECOVERY_E2E_ROOT;
test.skip(!root, "Set INKOS_RECOVERY_E2E_ROOT to a synthetic project under repository temp.");

test.beforeEach(() => {
  const fixtureRelative = relative(resolve(import.meta.dirname, "../../../temp"), resolve(root!));
  expect(fixtureRelative && !fixtureRelative.startsWith("..") && !isAbsolute(fixtureRelative)).toBeTruthy();
});

async function emptyBook(prefix: string) {
  const id = `${prefix}-${Date.now()}`;
  const book = join(root!, "books", id);
  await mkdir(join(book, "story", "recovery"), { recursive: true });
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "book.json"), JSON.stringify({
    id, title: id, platform: "qidian", genre: "urban", status: "outlining", language: "en",
    targetChapters: 3, chapterWordCount: 3000,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  }), "utf8");
  await writeFile(join(book, "chapters", "index.json"), "[]", "utf8");
  return { id, book };
}

async function legacyCandidate(book: string, candidateId: string) {
  const directory = join(book, "story", "recovery", "candidates", candidateId);
  await mkdir(directory, { recursive: true });
  const record = JSON.stringify({
    version: 1, candidateId, operationId: randomUUID(), chapter: 1, mode: "rework",
    createdAt: "2026-09-12T00:00:00.000Z",
    inputs: { sourceHash: "synthetic", baselineHash: "synthetic", controlHash: "synthetic" },
    output: { revisedContent: "Synthetic retained candidate.", wordCount: 3, fixedIssues: [] },
  });
  await writeFile(join(directory, "candidate.json"), record, "utf8");
  return record;
}

test("persisted settlement evidence survives reload and bounded action failures remain reviewable", async ({ page }) => {
  const { id, book } = await emptyBook("settlement-evidence");
  const prose = "Mira reads a hidden letter. She makes no promise.";
  await writeFile(join(book, "chapters", "0001_retained.md"), prose, "utf8");
  const attempt = await createSettlementAttempt(book, {
    chapter: 1, inputs: { sourceHash: "synthetic", baselineHash: "synthetic", controlHash: "synthetic" }, context: { baselineChapter: 0 },
    output: { chapterNumber: 1, title: "One", content: prose, wordCount: 10, preWriteCheck: "", postSettlement: "notes", updatedState: "Mira reads the letter.", updatedLedger: "", updatedHooks: "Unresolved letter", chapterSummary: "summary", updatedSubplots: "", updatedEmotionalArcs: "", updatedCharacterMatrix: "", postWriteErrors: [], postWriteWarnings: [] },
  });
  await appendSettlementEvent(book, attempt.attemptId, { type: "rejected", data: { reasonCode: "SEMANTIC_REJECTION", issues: ["Unsupported agreement", "<script>not executable</script>"] } });
  // Only resume is a transport substitute: diagnostics and status use the real server/storage.
  const actions: string[] = [];
  await page.route(`**/api/v1/books/${id}/settlements/${attempt.attemptId}/resume`, async route => {
    actions.push(route.request().postDataJSON().action);
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ status: "failed", attemptId: attempt.attemptId, reasonCode: "SETTLEMENT_NO_PROGRESS", stage: "validation", issues: ["Synthetic bounded rejection"] }) });
  });
  await page.goto(`/#/book/${id}/settings`);
  await page.getByRole("combobox", { name: "Settlement attempts" }).selectOption(attempt.attemptId);
  await page.getByRole("button", { name: "Inspect settlement evidence" }).click();
  await expect(page.getByLabel("Settlement evidence")).toContainText("Unsupported agreement");
  await expect(page.getByLabel("Settlement evidence")).toContainText("<script>not executable</script>");
  await expect(page.getByLabel("Settlement evidence").locator("script")).toHaveCount(0);
  await page.getByRole("button", { name: "Revalidate candidate", exact: true }).click();
  await expect(page.getByText("Synthetic bounded rejection", { exact: false })).toBeVisible();
  expect(actions).toEqual(["revalidate"]);
  await page.reload();
  await page.getByRole("combobox", { name: "Settlement attempts" }).selectOption(attempt.attemptId);
  await page.getByRole("button", { name: "Inspect settlement evidence" }).click();
  await expect(page.getByLabel("Settlement evidence")).toContainText("Unsupported agreement");
  expect(await readFile(join(book, "chapters", "0001_retained.md"), "utf8")).toBe(prose);
});

test("orphan chapters remain selectable through preview and recovery submission", async ({ page }) => {
  const { id, book } = await emptyBook("orphan-target");
  for (const chapter of [0, 1]) {
    const snapshot = join(book, "story", "snapshots", String(chapter));
    await mkdir(snapshot, { recursive: true });
    for (const file of ["current_state.md", "pending_hooks.md"]) await writeFile(join(snapshot, file), "Synthetic baseline", "utf8");
  }
  for (const chapter of [1, 2]) await writeFile(join(book, "chapters", `${chapter}-retained.md`), `# Chapter ${chapter}\n\nRetained prose`, "utf8");
  await writeFile(join(book, "chapters", "index.json"), JSON.stringify([{ number: 1, title: "One", status: "ready-for-review" }]), "utf8");
  const submissions: unknown[] = [];
  await page.route(`**/api/v1/books/${id}/recover/2`, async route => {
    const body = route.request().postDataJSON();
    if (body.dryRun) { await route.continue(); return; }
    submissions.push(body);
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ status: "failed", reasonCode: "SYNTHETIC_SETTLEMENT_STOP", completed: [] }) });
  });
  await page.goto(`/#/book/${id}/settings`);
  const target = page.getByRole("combobox", { name: "Through chapter" });
  await expect(target.locator("option")).toHaveText(["1", "2"]);
  await target.selectOption("2");
  await expect(target).toHaveValue("2");
  await page.getByRole("button", { name: "Preview plan", exact: true }).click();
  await expect(page.getByText("Baseline → chapters: 1 → 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run recovery", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(target).toHaveValue("2");
  expect(await readFile(join(book, "chapters", "2-retained.md"), "utf8")).toContain("Retained prose");
});

for (const empty of [true, false]) {
  test(`interrupted publication stays recoverable (${empty ? "empty index" : "retained chapter"})`, async ({ page, request }) => {
    const tempRoot = resolve(import.meta.dirname, "../../../temp");
    const fixtureRelative = relative(tempRoot, resolve(root!));
    expect(fixtureRelative && !fixtureRelative.startsWith("..") && !isAbsolute(fixtureRelative)).toBeTruthy();
    const id = `recovery-${empty ? "empty" : "chapter"}-${Date.now()}`;
    const book = join(root!, "books", id);
    await mkdir(join(book, "story"), { recursive: true });
    await mkdir(join(book, "chapters"), { recursive: true });
    const configPath = join(book, "book.json");
    const originalConfig = Buffer.from(JSON.stringify({
      id, title: id, platform: "qidian", genre: "urban", status: "outlining",
      language: "en", targetChapters: 3, chapterWordCount: 3000,
      createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
    }, null, 2).replace(/\n/g, "\r\n"));
    await writeFile(configPath, originalConfig);
    const indexPath = join(book, "chapters", "index.json");
    const originalIndex = Buffer.from(JSON.stringify(empty ? [] : [{
      number: 1, title: "Retained chapter", status: "drafted", wordCount: 5,
      createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
    }]));
    await writeFile(indexPath, originalIndex);
    const prose = "# Retained chapter\r\n\r\nOriginal synthetic prose.\r\n";
    if (!empty) await writeFile(join(book, "chapters", "0001.md"), prose, "utf8");

    async function interrupt() {
      await expect(withBookTransaction(book, async () => {
        await writeFile(configPath, "incomplete publication", "utf8");
        await writeFile(indexPath, "[]", "utf8");
        throw new Error("synthetic interruption");
      }, { leavePendingOnError: true })).rejects.toThrow("synthetic interruption");
    }

    const mutations: string[] = [];
    page.on("request", outgoing => {
      if (outgoing.method() === "POST" && outgoing.url().includes(`/books/${id}/`)) mutations.push(new URL(outgoing.url()).pathname);
    });
    async function recoverFromFallback() {
      await expect(page.getByRole("button", { name: /Recover interrupted transaction|\u6062\u590d\u4e2d\u65ad\u4e8b\u52a1/ })).toBeEnabled();
      await expect(page.getByRole("button", { name: /Run recovery|\u6267\u884c\u6062\u590d/, exact: true })).toBeDisabled();
      const response = page.waitForResponse(res => res.url().endsWith(`/books/${id}/recover-transaction`) && res.request().method() === "POST");
      await page.getByRole("button", { name: /Recover interrupted transaction|\u6062\u590d\u4e2d\u65ad\u4e8b\u52a1/ }).click();
      const recovered = await response;
      expect(recovered.status()).toBe(200);
      expect(await recovered.json()).toMatchObject({ status: "applied" });
      await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
      expect(await readFile(configPath)).toEqual(originalConfig);
      expect(await readFile(indexPath)).toEqual(originalIndex);
      expect((await request.get(`/api/v1/books/${id}`)).status()).toBe(200);
      const repeated = await request.post(`/api/v1/books/${id}/recover-transaction`);
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toMatchObject({ status: "unchanged" });
    }

    await interrupt();
    expect((await request.get(`/api/v1/books/${id}`)).status()).toBe(409);
    await page.goto(`/#/book/${id}/settings`);
    await recoverFromFallback();

    // A book that was already open must also recover when its next detail load fails.
    await interrupt();
    await page.reload();
    await recoverFromFallback();
    expect(mutations).toEqual(Array(2).fill(`/api/v1/books/${id}/recover-transaction`));
    expect((await readdir(join(book, "chapters"))).sort()).toEqual(empty ? ["index.json"] : ["0001.md", "index.json"]);
    if (!empty) expect(await readFile(join(book, "chapters", "0001.md"), "utf8")).toBe(prose);
  });
}

test("reservation-only interruption exposes transaction recovery without a journal", async ({ page, request }) => {
  const { id, book } = await emptyBook("reservation-only");
  const before = await readFile(join(book, "book.json"));
  await writeFile(join(book, "story", "recovery", "transaction-owner.json"), JSON.stringify({
    token: randomUUID(), pid: 2147483647, host: hostname(),
  }), "utf8");
  expect((await request.get(`/api/v1/books/${id}`)).status()).toBe(409);
  await page.goto(`/#/book/${id}/settings`);
  const action = page.getByRole("button", { name: /Recover interrupted transaction|\u6062\u590d\u4e2d\u65ad\u4e8b\u52a1/ });
  await expect(action).toBeEnabled();
  const result = page.waitForResponse(response => response.url().endsWith(`/books/${id}/recover-transaction`));
  await action.click();
  expect((await result).status()).toBe(200);
  await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
  expect(await readFile(join(book, "book.json"))).toEqual(before);
  expect((await request.get(`/api/v1/books/${id}`)).status()).toBe(200);
  await expect(readFile(join(book, "story", "recovery", "transaction-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("real legacy candidate discovery requires an explicit publication policy", async ({ page, request }) => {
  const { id, book } = await emptyBook("legacy-discovery");
  const candidateId = randomUUID();
  const record = await legacyCandidate(book, candidateId);
  const diagnosis = await (await request.get(`/api/v1/books/${id}/recovery-status`)).json();
  expect(diagnosis.candidates).toContainEqual(expect.objectContaining({ candidateId, status: "pending", policySource: "missing", issue: "CANDIDATE_POLICY_REQUIRED" }));
  const submitted: unknown[] = [];
  // Only settlement is stubbed: UI discovery uses the real API and retained v1 record.
  await page.route(`**/api/v1/books/${id}/resume-candidate/${candidateId}`, async route => {
    submitted.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: false, candidateId }) });
  });
  await page.goto(`/#/book/${id}/settings`);
  await page.getByRole("combobox", { name: "Available candidates", exact: true }).selectOption(candidateId);
  await expect(page.getByRole("textbox", { name: "Preserved candidate ID" })).toHaveValue(candidateId);
  const policy = page.getByRole("combobox", { name: "Legacy publication policy", exact: true });
  await expect(policy).toHaveValue("");
  const retry = page.getByRole("button", { name: "Retry candidate settlement", exact: true });
  await expect(retry).toBeDisabled();
  expect(submitted).toEqual([]);
  await policy.selectOption("strict");
  await retry.click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted).toEqual([{ legacyRevisionGate: "strict" }]);
  expect(await readFile(join(book, "story", "recovery", "candidates", candidateId, "candidate.json"), "utf8")).toBe(record);
});

test("policy-required response exposes explicit selection without guessing a default", async ({ page }) => {
  const { id, book } = await emptyBook("legacy-response");
  const candidateId = randomUUID();
  await page.goto(`/#/book/${id}/settings`);
  await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Legacy publication policy", exact: true })).toHaveCount(0);
  const submitted: unknown[] = [];
  await page.route(`**/api/v1/books/${id}/resume-candidate/${candidateId}`, async route => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) {
      // A candidate created after the page's initial diagnosis becomes discoverable on refresh.
      await legacyCandidate(book, candidateId);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ status: "blocked", reasonCode: "CANDIDATE_POLICY_REQUIRED", candidateId }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: false, candidateId }) });
    }
  });
  await page.getByRole("textbox", { name: "Preserved candidate ID" }).fill(candidateId);
  const retry = page.getByRole("button", { name: "Retry candidate settlement", exact: true });
  await retry.click();
  const policy = page.getByRole("combobox", { name: "Legacy publication policy", exact: true });
  await expect(policy).toHaveValue("");
  await expect(retry).toBeDisabled();
  expect(submitted).toEqual([{}]);
  await policy.selectOption("lenient");
  await retry.click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted).toEqual([{}, { legacyRevisionGate: "lenient" }]);
});
