export const deletionConfirmationSettingKey = "confirm_deletions";
export const onboardingCompletedSettingKey = "onboarding_completed";

const activityCenterStorageKey = "dmh.activity-center.enabled.v1";

export function readActivityCenterEnabled(): boolean {
  try {
    return window.localStorage.getItem(activityCenterStorageKey) === "true";
  } catch {
    return false;
  }
}

export function saveActivityCenterEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(activityCenterStorageKey, String(enabled));
  } catch {
    // The current session can still use the selection when local storage is unavailable.
  }
}
