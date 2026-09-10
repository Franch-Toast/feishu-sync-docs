/**
 * First-run guided flow (B6.1): configure credentials → bind a root → first sync.
 *
 * Everything here is a pure function over a snapshot of the workspace so the
 * wizard's state machine can be unit-tested without rendering React. The
 * wizard is advisory only — it can be dismissed and never blocks any action
 * (the "强制三步向导" variant is explicitly out of scope).
 */

export type OnboardingStepId = "credential" | "bind-root" | "first-sync";

/** Facts about the workspace that drive step completion. */
export interface OnboardingSnapshot {
  /** Credentials are present and verified by the server. */
  credentialReady: boolean;
  /** At least one sync root is bound. */
  rootBound: boolean;
  /** At least one sync round finished for some root. */
  synced: boolean;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  hint: string;
  /** Label of the button that takes the user to the matching screen. */
  actionLabel: string;
  done: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  /** Index of the first unfinished step, or -1 when all steps are done. */
  activeIndex: number;
  complete: boolean;
  doneCount: number;
  /** Compact progress label such as "2/3". */
  progress: string;
}

/** Step copy in display order; completion is derived, never stored. */
const STEP_COPY: ReadonlyArray<Omit<OnboardingStep, "done">> = [
  {
    id: "credential",
    title: "配置飞书凭证",
    hint: "在「设置」页填写用户 Token 或应用凭证，并通过「测试连接」确认可访问云文档。",
    actionLabel: "打开设置"
  },
  {
    id: "bind-root",
    title: "绑定同步根目录",
    hint: "把一个本地目录连到一个飞书文件夹（或知识空间节点），表单会即时校验路径与 token。",
    actionLabel: "绑定根目录"
  },
  {
    id: "first-sync",
    title: "完成首次同步",
    hint: "点击「立即同步」跑一轮：本地文档会上传，远端文档会拉回，之后的改动自动双向同步。",
    actionLabel: "查看仪表盘"
  }
];

/** localStorage key for "不再显示"; kept in this browser on purpose (B6.1). */
export const ONBOARDING_DISMISS_KEY = "feishu-sync.onboarding.dismissed";

function isDone(id: OnboardingStepId, snapshot: OnboardingSnapshot): boolean {
  if (id === "credential") return snapshot.credentialReady;
  if (id === "bind-root") return snapshot.rootBound;
  return snapshot.synced;
}

/** Derive the wizard state (steps, active index, progress) from a snapshot. */
export function computeOnboarding(snapshot: OnboardingSnapshot): OnboardingState {
  const steps = STEP_COPY.map((step) => ({ ...step, done: isDone(step.id, snapshot) }));
  const activeIndex = steps.findIndex((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;
  return {
    steps,
    activeIndex,
    complete: activeIndex === -1,
    doneCount,
    progress: `${doneCount}/${steps.length}`
  };
}

/** Read the "不再显示" flag; a missing/corrupt store simply means "not dismissed". */
export function readOnboardingDismissed(storage: Pick<Storage, "getItem"> | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ONBOARDING_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the "不再显示" flag. */
export function writeOnboardingDismissed(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, dismissed: boolean): void {
  if (!storage) return;
  try {
    if (dismissed) storage.setItem(ONBOARDING_DISMISS_KEY, "1");
    else storage.removeItem(ONBOARDING_DISMISS_KEY);
  } catch {
    /* private mode / quota — the wizard simply shows again next visit */
  }
}

/**
 * Whether the modal wizard should open.
 *
 * `loaded` gates on the first successful settings fetch so the wizard never
 * flashes "step 1 undone" before the workspace state arrives. The dashboard
 * quick-start card ignores `dismissed` (it is passive) but honours `loaded`
 * and `complete`.
 */
export function shouldShowOnboardingWizard(input: { snapshot: OnboardingSnapshot; dismissed: boolean; loaded: boolean }): boolean {
  if (!input.loaded || input.dismissed) return false;
  return !computeOnboarding(input.snapshot).complete;
}

/** Whether the dashboard quick-start card should render. */
export function shouldShowQuickStart(input: { snapshot: OnboardingSnapshot; loaded: boolean }): boolean {
  if (!input.loaded) return false;
  return !computeOnboarding(input.snapshot).complete;
}
