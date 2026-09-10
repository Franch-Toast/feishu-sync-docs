import React from "react";
import type { OnboardingState, OnboardingStepId } from "../onboarding";

interface OnboardingWizardProps {
  state: OnboardingState;
  /** Jump to the screen that satisfies a step (settings / bind modal / dashboard). */
  onStepAction: (stepId: OnboardingStepId) => void;
  /** Close without persisting anything — the wizard reopens on the next visit. */
  onClose: () => void;
  /** "不再显示" — the caller persists it in localStorage. */
  onDismiss: () => void;
}

/** Numbered step row shared by the modal wizard and the dashboard card. */
function StepRow({ state, index, onStepAction }: { state: OnboardingState; index: number; onStepAction: (stepId: OnboardingStepId) => void }): React.JSX.Element {
  const step = state.steps[index]!;
  const active = index === state.activeIndex;
  return <li className={`onboarding-step${step.done ? " done" : ""}${active ? " active" : ""}`}>
    <span className="step-index">{step.done ? "✓" : index + 1}</span>
    <span className="step-body">
      <strong>{step.title}</strong>
      <small className="muted">{step.hint}</small>
    </span>
    {!step.done && <button className={active ? "primary" : "secondary"} onClick={() => onStepAction(step.id)}>{step.actionLabel}</button>}
  </li>;
}

/** First-run welcome wizard (B6.1). Advisory only: every step stays skippable
 *  and the modal never blocks navigation. */
export function OnboardingWizard({ state, onStepAction, onClose, onDismiss }: OnboardingWizardProps): React.JSX.Element {
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal onboarding-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-heading">
        <div>
          <h3>欢迎使用 Feishu Local Sync</h3>
          <span className="muted">三步开始双向同步 · 进度 {state.progress}</span>
        </div>
        <button className="secondary" onClick={onClose}>关闭</button>
      </div>
      <div className="onboarding-progress" aria-hidden="true">
        {state.steps.map((step, index) => <span key={step.id} className={step.done ? "filled" : index === state.activeIndex ? "current" : ""} />)}
      </div>
      <ol className="onboarding-steps">
        {state.steps.map((step, index) => <StepRow key={step.id} state={state} index={index} onStepAction={onStepAction} />)}
      </ol>
      <div className="form-actions">
        <button className="link-button" onClick={onDismiss}>不再显示</button>
        <button className="secondary" onClick={onClose}>{state.complete ? "完成" : "稍后再说"}</button>
      </div>
      <p className="muted form-hint">「不再显示」只影响本浏览器的欢迎向导；仪表盘的「快速开始」卡片会在三步全部完成后自动消失。</p>
    </div>
  </div>;
}

interface QuickStartCardProps {
  state: OnboardingState;
  onStepAction: (stepId: OnboardingStepId) => void;
  onDismiss: () => void;
  onReopenWizard: () => void;
}

/** Passive dashboard card listing the remaining setup steps (B6.1). */
export function QuickStartCard({ state, onStepAction, onDismiss, onReopenWizard }: QuickStartCardProps): React.JSX.Element {
  return <section className="panel quick-start">
    <div className="panel-heading">
      <div>
        <h3>快速开始</h3>
        <span className="muted">已完成 {state.progress} 步 · {state.complete ? "全部就绪" : `下一步：${state.steps[state.activeIndex]?.title ?? ""}`}</span>
      </div>
      <div className="heading-actions">
        <button className="link-button" onClick={onReopenWizard}>查看向导</button>
        <button className="link-button" onClick={onDismiss}>不再显示</button>
      </div>
    </div>
    <ol className="onboarding-steps compact">
      {state.steps.map((step, index) => <StepRow key={step.id} state={state} index={index} onStepAction={onStepAction} />)}
    </ol>
  </section>;
}
