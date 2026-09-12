import { useEffect, useState } from "react";
import { requestBookRecovery, recoveryChapterTargets, mergeRecoveryResult, type RecoveryView } from "../lib/book-recovery-api";

export function SettlementDiagnostics({ view }: { view: RecoveryView }) {
  if (!view.attempt && !view.events) return null;
  return <pre className="text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto" aria-label="Settlement evidence">{JSON.stringify({ attempt: view.attempt, events: view.events }, null, 2)}</pre>;
}

export function BookRecoveryPanel({ bookId, chapters, language, candidate, busy, onChanged, initialInspect }: {
  bookId: string; chapters: readonly number[]; language?: string; candidate?: string; busy?: boolean; onChanged: () => void; initialInspect?: boolean;
}) {
  const en = language === "en";
  const [target, setTarget] = useState(chapters.at(-1) ?? 1);
  const [candidateId, setCandidateId] = useState(candidate ?? "");
  const [attemptId, setAttemptId] = useState("");
  const [evidence, setEvidence] = useState<RecoveryView>({});
  const [legacyGate, setLegacyGate] = useState("");
  const [view, setView] = useState<RecoveryView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (candidate) setCandidateId(candidate); }, [candidate]);
  const base = `/books/${encodeURIComponent(bookId)}`;
  useEffect(() => {
    let active = true;
    void requestBookRecovery(`${base}/recovery-status`).then(result => { if (active) setView(result); }, caught => { if (active) setError(String(caught)); });
    return () => { active = false; };
  }, [base, initialInspect]);
  const button = "px-3 py-2 text-xs font-semibold border border-border/50 rounded-lg hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed";
  const reason = view?.reasonCode ?? view?.plan?.blockedReason;
  const targetChapters = recoveryChapterTargets(chapters, view?.health?.pendingChapters);
  const selectedTarget = targetChapters.includes(target) ? target : targetChapters.at(-1) ?? 1;
  const liveOwner = view?.health?.issues.some(issue => issue.code === "BOOK_BUSY");
  const selectedCandidate = view?.candidates?.find(entry => entry.candidateId === candidateId.trim());
  const selectedAttempt = view?.settlementAttempts?.find(entry => entry.attemptId === attemptId);
  const needsLegacyPolicy = selectedCandidate?.policySource === "missing" || (view?.reasonCode === "CANDIDATE_POLICY_REQUIRED" && view.candidateId === candidateId.trim());
  const reasonLabels: Record<string, string> = {
    BASELINE_MISSING: en ? "A verified initial state or backup is required." : "需要可验证的初始状态或备份。",
    BOOK_BUSY: en ? "Another operation owns this book. Diagnosis remains available." : "另一个操作正在处理本书，仍可查看诊断。",
    TRANSACTION_RECOVERY_REQUIRED: en ? "An interrupted publication needs recovery before continuing." : "需要先恢复中断的发布事务。",
    CHAPTER_BODY_MISSING: en ? "A required chapter body is missing." : "缺少恢复所需的章节正文。",
    CANDIDATE_INPUTS_CHANGED: en ? "Candidate inputs changed. Inspect recovery again." : "候选输入已变化，请重新检查恢复计划。",
    CANDIDATE_POLICY_REQUIRED: en ? "Select a publication policy for this legacy candidate before retrying." : "此旧候选未记录发布规则，请明确选择后重试。",
  };
  const statusLabels: Record<string, string> = {
    applied: en ? "Recovery applied." : "恢复已完成。",
    unchanged: en ? "State already verified; no changes needed." : "状态已验证，无需修改。",
    blocked: en ? "Recovery blocked." : "恢复受阻。",
    failed: en ? "Recovery failed; inspect the reason before retrying." : "恢复失败，请先检查原因。",
    cancelled: en ? "Recovery cancelled." : "恢复已取消。",
  };
  async function request(path: string, body?: unknown) {
    setPending(true); setError("");
    try {
      const result = await requestBookRecovery(path, body);
      if (result.attempt) { setEvidence(result); return; }
      const isMutation = body && !(body as { dryRun?: boolean }).dryRun;
      let latest: RecoveryView = {};
      if (isMutation) latest = await requestBookRecovery(`${base}/recovery-status`).catch(() => ({}));
      setView(current => mergeRecoveryResult(current, latest, result));
      if (result.reasonCode !== "CANDIDATE_POLICY_REQUIRED") setLegacyGate("");
      if (result.candidateId) setCandidateId(result.candidateId);
      if (isMutation && (result.status === "applied" || result.status === "unchanged" || result.applied || result.completed?.length)) onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setPending(false); }
  }
  const status = view?.applied === false ? (en ? "Revision not applied; candidate preserved." : "修订未发布，候选已保留。")
    : view?.applied && view.auditResult?.passed === false ? (en ? "Revision applied; audit failed." : "修订已发布，审计未通过。")
      : view?.status ? statusLabels[view.status] ?? view.status : (view?.applied ? (en ? "Revision applied." : "修订已发布。") : "");
  return <section className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6 space-y-4">
    <h2 className="text-sm font-bold">{en ? "State recovery" : "状态恢复"}</h2>
    <p className="text-xs text-muted-foreground">{en ? "Inspect the verified state, then preview recovery through the selected chapter. Recovery keeps published chapter bodies." : "先检查已验证状态，再预览恢复到指定章节的计划。恢复过程保留已发布正文。"}</p>
    <div className="flex flex-wrap items-center gap-2">
      <button className={button} disabled={pending} onClick={() => void request(`${base}/recovery-status`)}>{en ? "Check status" : "检查状态"}</button>
      {view?.health?.issues.some(issue => issue.code === "TRANSACTION_RECOVERY_REQUIRED") && <button className={button} disabled={pending || busy || liveOwner} onClick={() => void request(`${base}/recover-transaction`, {})}>{en ? "Recover interrupted transaction" : "恢复中断事务"}</button>}
      <label className="text-xs">{en ? "Through chapter" : "恢复到章节"}
        <select className="ml-2 p-2 border border-border/50 rounded-lg bg-background" value={selectedTarget} disabled={pending} onChange={event => { setTarget(Number(event.target.value)); setView(current => current ? { ...current, plan: undefined } : null); }}>
          {targetChapters.map(chapter => <option key={chapter} value={chapter}>{chapter}</option>)}
        </select>
      </label>
      <button className={button} disabled={pending || !targetChapters.length} onClick={() => void request(`${base}/recover/${selectedTarget}`, { dryRun: true })}>{en ? "Preview plan" : "预览计划"}</button>
      <button className={button} disabled={pending || busy || !view?.plan?.steps.length || !!view.plan.blockedReason} onClick={() => void request(`${base}/recover/${selectedTarget}`, {})}>{en ? "Run recovery" : "执行恢复"}</button>
    </div>
    {view?.health && <p className="text-xs">{en ? "Verified through" : "连续验证至"}: {view.health.stateFrontier ?? (en ? "none" : "无")} · {en ? "Pending chapters" : "待恢复章节"}: {view.health.pendingChapters.join(", ") || "—"}</p>}
    {view?.plan && <p className="text-xs">{en ? "Baseline → chapters" : "基线 → 恢复章节"}: {view.plan.baseline ?? "—"} → {view.plan.steps.map(step => step.chapter).join(" → ") || "—"}</p>}
    {view?.availableBaselineBackup && <div className="space-y-2 text-xs">
      <p>{en ? "Verified initial-state backup" : "已验证的初始状态备份"}: <code>{view.availableBaselineBackup.backupId}</code></p>
      <p className="text-muted-foreground">{en ? "Restores snapshot zero and marks chapter state for recovery. Existing prose and live canon remain in place." : "恢复初始快照，并将章节状态标记为待恢复。保留现有正文和当前设定。"}</p>
      <button className={button} disabled={pending || busy} onClick={() => void request(`${base}/restore-baseline/${view.availableBaselineBackup!.backupId}`, {})}>{en ? "Restore this initial snapshot" : "恢复此初始快照"}</button>
    </div>}
    {view?.health?.issues.length ? <p className="text-xs text-amber-600">{[...new Set(view.health.issues.map(issue => reasonLabels[issue.code] ?? issue.code))].join(" · ")}</p> : null}
    {status && <p role="status" className="text-xs">{status}{view?.completed?.length ? ` (${view.completed.join(", ")})` : ""}</p>}
    {(error || view?.error || reason) && <p role="alert" className="text-xs text-destructive">{error || view?.error || (reason && (reasonLabels[reason] ?? reason))}</p>}
    {view?.stage && <p className="text-xs">{en ? "Stage" : "阶段"}: {view.stage}</p>}
    {view?.issues?.length ? <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(view.issues, null, 2)}</pre> : null}
    <div className="space-y-2">
      <label className="text-xs">{en ? "Settlement attempts" : "状态结算尝试"}<select aria-label={en ? "Settlement attempts" : "状态结算尝试"} className="ml-2 p-2 border rounded bg-background" value={attemptId} onChange={event => { setAttemptId(event.target.value); setEvidence({}); }}>
        <option value="">{en ? "Select attempt" : "选择结算尝试"}</option>
        {view?.settlementAttempts?.map(entry => <option key={entry.attemptId} value={entry.attemptId}>{entry.chapter}: {entry.status} · {entry.attemptId}</option>)}
      </select></label>
      <button className={button} disabled={pending || !attemptId} onClick={() => void request(`${base}/settlements/${encodeURIComponent(attemptId)}`)}>{en ? "Inspect settlement evidence" : "查看结算证据"}</button>
      {(["revalidate", "repair"] as const).map(action => <button key={action} className={button} disabled={pending || busy || liveOwner || !selectedAttempt?.resumable || selectedAttempt.status === "applied" || selectedAttempt.status === "discarded"} onClick={() => void request(`${base}/settlements/${encodeURIComponent(attemptId)}/resume`, { action })}>{action === "revalidate" ? (en ? "Revalidate candidate" : "重新校验候选") : (en ? "Repair candidate" : "修复候选")}</button>)}
      <p className="text-xs text-muted-foreground">{en ? "Verify feedback against the chapter. Unsupported feedback does not justify changing character settings." : "请对照正文核实反馈；无依据的校验意见不能作为修改角色设定的理由。"}</p>
      <SettlementDiagnostics view={evidence} />
    </div>
    <div className="flex flex-wrap gap-2 items-center">
      {view?.candidates?.some(entry => entry.status === "pending") && <label className="text-xs">{en ? "Available candidates" : "可重试候选"}<select aria-label={en ? "Available candidates" : "可重试候选"} className="ml-2 p-2 border rounded bg-background" value={view.candidates.some(entry => entry.candidateId === candidateId) ? candidateId : ""} onChange={event => { setCandidateId(event.target.value); setLegacyGate(""); }}>
        <option value="">{en ? "Select candidate" : "选择候选"}</option>
        {view.candidates.filter(entry => entry.status === "pending").map(entry => <option key={entry.candidateId} value={entry.candidateId}>{entry.chapter ?? "?"}: {entry.candidateId}</option>)}
      </select></label>}
      <label className="text-xs">{en ? "Preserved candidate ID" : "保留候选编号"}<input className="ml-2 p-2 border border-border/50 rounded-lg bg-background" value={candidateId} onChange={event => { setCandidateId(event.target.value); setLegacyGate(""); }} /></label>
      {selectedCandidate?.publicationPolicy && <span className="text-xs">{en ? "Saved policy" : "已保存规则"}: {selectedCandidate.publicationPolicy.revisionGate}</span>}
      {needsLegacyPolicy && <label className="text-xs">{en ? "Legacy publication policy" : "旧候选发布规则"}<select aria-label={en ? "Legacy publication policy" : "旧候选发布规则"} value={legacyGate} onChange={event => setLegacyGate(event.target.value)} className="ml-2 p-2 border rounded bg-background">
        <option value="">{en ? "Select explicitly" : "请选择"}</option>
        <option value="strict">{en ? "Strict: audit must improve" : "严格：审计必须改善"}</option>
        <option value="lenient">{en ? "Lenient: audit must not worsen" : "宽松：审计不能恶化"}</option>
        <option value="always">{en ? "Apply after valid settlement" : "状态校验通过后发布"}</option>
      </select></label>}
      <button className={button} disabled={pending || busy || !candidateId.trim() || (needsLegacyPolicy && !legacyGate)} onClick={() => void request(`${base}/resume-candidate/${encodeURIComponent(candidateId.trim())}`, needsLegacyPolicy && legacyGate ? { legacyRevisionGate: legacyGate } : {})}>{en ? "Retry candidate settlement" : "重试候选结算"}</button>
      {pending && <span role="status" className="text-xs text-muted-foreground">{en ? "Working…" : "处理中…"}</span>}
    </div>
  </section>;
}
