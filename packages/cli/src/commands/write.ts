import { Command } from "commander";
import { listSettlementAttempts, loadSettlementAttempt, readSettlementEvents, readBookConsistently } from "@actalk/inkos-core";
import { PipelineRunner, StateManager, resolveChapterReviewMode, inspectBookHealth, planBookRecovery, listRecoveryCandidates, findRecoveryBaseline, discardRecoveryCandidate } from "@actalk/inkos-core";
import { createInterface } from "node:readline";
import { loadConfig, buildPipelineConfig, findProjectRoot, getLegacyMigrationHint, resolveContext, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyBatchWriteBody,
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
  resolveCliLanguage,
  type CliLanguage,
} from "../localization.js";
import { sendCommandNotification } from "../notify-helper.js";

export const writeCommand = new Command("write")
  .description("Write chapters");

function recoveryTarget(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("INVALID_RECOVERY_TARGET: chapter must be a positive integer / 章节必须为正整数");
  return Number(raw);
}

async function recoveryArguments(args: ReadonlyArray<string>, root: string): Promise<{ bookId: string; value: string }> {
  if (args.length < 1 || args.length > 2) throw new Error("Expected [book-id] <chapter-or-candidate> / 请指定章节或候选编号");
  return { bookId: await resolveBookId(args.length === 2 ? args[0] : undefined, root), value: args.at(-1)! };
}

function recoveryError(error: unknown, json: boolean): void {
  const failure = error as { candidateId?: string; attemptId?: string; reasonCode?: string; code?: string; stage?: string; name?: string; issues?: unknown[]; nextActions?: unknown[] };
  if (json) log(JSON.stringify({ status: failure.name === "AbortError" ? "cancelled" : "failed", error: String(error), candidateId: failure.candidateId, attemptId: failure.attemptId, reasonCode: failure.reasonCode ?? failure.code, stage: failure.stage, issues: failure.issues, nextActions: failure.nextActions }));
  else logError(`Recovery failed / 恢复失败: ${String(error)}${failure.attemptId ? ` Settlement: ${failure.attemptId}; use write inspect-settlement.` : ""}${failure.candidateId ? ` Candidate: ${failure.candidateId}; use write resume-candidate.` : ""}`);
  process.exitCode = 1;
}

writeCommand.command("recover-transaction")
  .description("Recover interrupted publication without model configuration / 恢复中断事务")
  .argument("[book-id]")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      log(JSON.stringify(await new StateManager(root).recoverPendingTransaction(bookId), null, 2));
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("recovery-status")
  .description("Inspect state integrity without model calls / 只读检查状态完整性")
  .argument("[book-id]")
  .option("--chapter <n>", "Preview recovery through chapter")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const health = await inspectBookHealth(new StateManager(root).bookDir(bookId));
      const candidates = await listRecoveryCandidates(new StateManager(root).bookDir(bookId));
      const settlementAttempts = await listSettlementAttempts(new StateManager(root).bookDir(bookId));
      const availableBaselineBackup = health.verifiedBaselines.includes(0) ? null : await findRecoveryBaseline(new StateManager(root).bookDir(bookId));
      const result = { health, candidates, settlementAttempts, availableBaselineBackup, ...(opts.chapter ? { plan: planBookRecovery(health, recoveryTarget(opts.chapter)) } : {}) };
      log(JSON.stringify(result, null, 2));
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("restore-baseline")
  .description("Restore snapshot zero from a selected verified backup / 从指定已验证备份恢复初始快照")
  .argument("<args...>", "[book-id] <backup-id>")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookId, value: backupId } = await recoveryArguments(args, root);
      const state = new StateManager(root);
      await state.restoreRecoveryBaseline(bookId, backupId);
      log(JSON.stringify({ status: "applied", backupId, health: await inspectBookHealth(state.bookDir(bookId)) }, null, 2));
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("recover")
  .description("Recover retained chapter state in order / 按顺序恢复已有正文的状态")
  .argument("<args...>", "[book-id] <chapter>")
  .option("--dry-run", "Inspect the recovery plan without changing files")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookId, value } = await recoveryArguments(args, root);
      const chapter = recoveryTarget(value);
      if (opts.dryRun) {
        const health = await inspectBookHealth(new StateManager(root).bookDir(bookId));
        const plan = planBookRecovery(health, chapter);
        log(JSON.stringify({ health, plan }, null, 2));
        if (plan.blockedReason) process.exitCode = 1;
        return;
      }
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const result = await pipeline.recoverChapters(bookId, chapter);
      log(JSON.stringify(result, null, 2));
      if (!["applied", "unchanged"].includes(result.status)) process.exitCode = 1;
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("discard-candidate")
  .description("Discard an unpublished revision candidate, retaining its evidence and published prose")
  .argument("<args...>", "[book-id] <candidate-id>")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookId, value: candidateId } = await recoveryArguments(args, root);
      const state = new StateManager(root);
      const release = await state.acquireBookLock(bookId);
      try { await discardRecoveryCandidate(state.bookDir(bookId), candidateId); }
      finally { await release(); }
      log(JSON.stringify({ status: "discarded", candidateId, preservesBodies: true }));
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("inspect-settlement")
  .description("Read a saved settlement and validation evidence without model calls")
  .argument("<args...>", "[book-id] <attempt-id>")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookId, value: attemptId } = await recoveryArguments(args, root);
      const bookDir = new StateManager(root).bookDir(bookId);
      const result = await readBookConsistently(bookDir, async () => ({ attempt: await loadSettlementAttempt(bookDir, attemptId), events: await readSettlementEvents(bookDir, attemptId) }));
      log(JSON.stringify(result, null, 2));
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("resume-settlement")
  .description("Revalidate or repair a preserved settlement within a finite budget")
  .argument("<args...>", "[book-id] <attempt-id>")
  .requiredOption("--action <action>", "revalidate or repair")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      if (opts.action !== "revalidate" && opts.action !== "repair") throw new Error("INVALID_SETTLEMENT_ACTION");
      const root = findProjectRoot();
      const { bookId, value: attemptId } = await recoveryArguments(args, root);
      const pipeline = new PipelineRunner(buildPipelineConfig(await loadConfig(), root));
      const result = await pipeline.resumeSettlementAttempt(bookId, attemptId, opts.action);
      log(JSON.stringify(result, null, 2));
      if (!["applied", "unchanged"].includes(result.status)) process.exitCode = 1;
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand.command("resume-candidate")
  .description("Retry settlement of a preserved revision / 重试保留候选的状态结算")
  .argument("<args...>", "[book-id] <candidate-id>")
  .option("--json", "Output JSON")
  .option("--legacy-revision-gate <gate>", "Explicit policy for a legacy candidate: strict, lenient, always")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookId, value: candidateId } = await recoveryArguments(args, root);
      if (opts.legacyRevisionGate && !["strict", "lenient", "always"].includes(opts.legacyRevisionGate)) throw new Error("INVALID_CANDIDATE_POLICY");
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const result = opts.legacyRevisionGate
        ? await pipeline.resumeRevisionCandidate(bookId, candidateId, { legacyRevisionGate: opts.legacyRevisionGate })
        : await pipeline.resumeRevisionCandidate(bookId, candidateId);
      log(JSON.stringify(result, null, 2));
      if (!result.applied) process.exitCode = 1;
    } catch (error) { recoveryError(error, opts.json); }
  });

writeCommand
  .command("next")
  .description("Write the next chapter for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--count <n>", "Number of chapters to write", "1")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      notifyLanguage = language;
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(`[migration] ${migrationHint}`);
      }
      const config = await loadConfig();

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: context,
        quiet: opts.quiet,
        chapterReviewMode: resolveChapterReviewMode(book, config.writing),
      }));

      const count = parseInt(opts.count, 10);
      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const results = [];
      for (let i = 0; i < count; i++) {
        if (!opts.json) log(formatWriteNextProgress(language, i + 1, count, bookId));

        const result = await pipeline.writeNextChapter(bookId, wordCount);
        results.push(result);

        if (!opts.json) {
          for (const line of formatWriteNextResultLines(language, {
            chapterNumber: result.chapterNumber,
            title: result.title,
            wordCount: result.wordCount,
            auditPassed: result.auditResult.passed,
            revised: result.revised,
            status: result.status,
            issues: result.auditResult.issues,
          })) {
            log(line);
          }
          log("");
        }

        if (result.status === "state-degraded") {
          if (!opts.json) {
            log(language === "en"
              ? "State repair required before continuing. Stopping batch."
              : "需要先修复 state，已停止后续连写。");
          }
          break;
        }
      }

      if (opts.json) {
        log(JSON.stringify(results, null, 2));
      } else {
        log(formatWriteNextComplete(language));
      }

      // The pipeline itself already sends one notification per completed
      // chapter whenever notify channels are configured (runner.ts, end of
      // writeNextChapter). A single-chapter run would therefore duplicate that
      // exact notification — only send a command-level batch summary when this
      // run wrote more than one chapter.
      if (opts.notify && results.length > 1) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(language, "write-next", notifyBookName, true),
          body: formatNotifyBatchWriteBody(language, results.map((r) => ({
            chapterNumber: r.chapterNumber,
            title: r.title,
            wordCount: r.wordCount,
            auditPassed: r.auditResult.passed,
          }))),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "write-next", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to write chapter: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("rewrite")
  .description("Re-generate a specific chapter: rewrite [book-id] <chapter>")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--force", "Skip confirmation prompt")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--brief <text>", "One-off creative guidance for this rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (args: ReadonlyArray<string>, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write rewrite [book-id] <chapter>");
      }

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Rewrite chapter ${chapter} of "${bookId}"? This will delete chapter ${chapter} and all later chapters. (y/N) `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log("Cancelled.");
          return;
        }
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      notifyLanguage = resolveCliLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(`[migration] ${migrationHint}`);
      }

      if (!opts.json) log(`Regenerating chapter ${chapter}...`);

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        chapterReviewMode: resolveChapterReviewMode(book, config.writing),
      }));

      const result = await pipeline.rewriteFromChapter(bookId, chapter, wordCount);
      const language = resolveCliLanguage(book.language);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(language, {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }

      // Success notification intentionally skipped: the pipeline already sent
      // the per-chapter notification for this exact chapter (runner.ts, end of
      // writeNextChapter) — a command-level one would be a duplicate. --notify
      // only adds the failure notification for this command.
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "write-rewrite", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to rewrite chapter: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("sync")
  .description("Rebuild chapter truth/state from its body; later chapters keep their text but require state repair in order")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--brief <text>", "One-off guidance for how to interpret the edited chapter while syncing")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write sync [book-id] <chapter>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(bookId, chapter);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(language, {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to sync chapter artifacts: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("repair-state")
  .description("Rebuild truth files for a persisted state-degraded chapter without rewriting body text")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write repair-state [book-id] <chapter>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const result = await pipeline.repairChapterState(bookId, chapter);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(language, {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to repair chapter state: ${e}`);
      }
      process.exit(1);
    }
  });
