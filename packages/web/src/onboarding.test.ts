import { describe, expect, it } from "vitest";
import {
  computeOnboarding,
  ONBOARDING_DISMISS_KEY,
  readOnboardingDismissed,
  shouldShowOnboardingWizard,
  shouldShowQuickStart,
  writeOnboardingDismissed,
  type OnboardingSnapshot
} from "./onboarding";

function snapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return { credentialReady: false, rootBound: false, synced: false, ...overrides };
}

/** Minimal in-memory stand-in for window.localStorage. */
function fakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { dump: () => Record<string, string> } {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    dump: () => Object.fromEntries(store)
  };
}

describe("computeOnboarding (B6.1)", () => {
  it("lists the three setup steps in order", () => {
    const state = computeOnboarding(snapshot());
    expect(state.steps.map((step) => step.id)).toEqual(["credential", "bind-root", "first-sync"]);
    expect(state.steps.every((step) => !step.done)).toBe(true);
    expect(state.activeIndex).toBe(0);
    expect(state.complete).toBe(false);
    expect(state.progress).toBe("0/3");
  });

  it("points at the first unfinished step, skipping completed ones", () => {
    expect(computeOnboarding(snapshot({ credentialReady: true })).activeIndex).toBe(1);
    expect(computeOnboarding(snapshot({ credentialReady: true, rootBound: true })).activeIndex).toBe(2);
    expect(computeOnboarding(snapshot({ credentialReady: true, rootBound: true })).progress).toBe("2/3");
  });

  it("reports completion only when every step is done", () => {
    const done = computeOnboarding(snapshot({ credentialReady: true, rootBound: true, synced: true }));
    expect(done.complete).toBe(true);
    expect(done.activeIndex).toBe(-1);
    expect(done.doneCount).toBe(3);
    // A first sync without credentials still counts as unfinished setup.
    expect(computeOnboarding(snapshot({ synced: true })).complete).toBe(false);
  });

  it("gives every unfinished step an actionable label", () => {
    for (const step of computeOnboarding(snapshot()).steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.hint.length).toBeGreaterThan(0);
      expect(step.actionLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("onboarding visibility (B6.1)", () => {
  it("opens the wizard only once the workspace state has loaded", () => {
    expect(shouldShowOnboardingWizard({ snapshot: snapshot(), dismissed: false, loaded: false })).toBe(false);
    expect(shouldShowOnboardingWizard({ snapshot: snapshot(), dismissed: false, loaded: true })).toBe(true);
  });

  it("hides the wizard after dismissal but keeps the quick-start card", () => {
    const dismissed = shouldShowOnboardingWizard({ snapshot: snapshot(), dismissed: true, loaded: true });
    expect(dismissed).toBe(false);
    expect(shouldShowQuickStart({ snapshot: snapshot(), loaded: true })).toBe(true);
  });

  it("hides both once every step is done", () => {
    const complete = snapshot({ credentialReady: true, rootBound: true, synced: true });
    expect(shouldShowOnboardingWizard({ snapshot: complete, dismissed: false, loaded: true })).toBe(false);
    expect(shouldShowQuickStart({ snapshot: complete, loaded: true })).toBe(false);
    expect(shouldShowQuickStart({ snapshot: snapshot(), loaded: false })).toBe(false);
  });
});

describe("onboarding dismissal persistence (B6.1)", () => {
  it("round-trips the flag under a stable localStorage key", () => {
    const storage = fakeStorage();
    expect(readOnboardingDismissed(storage)).toBe(false);
    writeOnboardingDismissed(storage, true);
    expect(storage.getItem(ONBOARDING_DISMISS_KEY)).toBe("1");
    expect(readOnboardingDismissed(storage)).toBe(true);
    writeOnboardingDismissed(storage, false);
    expect(readOnboardingDismissed(storage)).toBe(false);
    expect(storage.dump()).toEqual({});
  });

  it("tolerates a missing or throwing store", () => {
    expect(readOnboardingDismissed(undefined)).toBe(false);
    expect(() => writeOnboardingDismissed(undefined, true)).not.toThrow();
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); }
    };
    expect(readOnboardingDismissed(throwing)).toBe(false);
    expect(() => writeOnboardingDismissed(throwing, true)).not.toThrow();
  });
});
