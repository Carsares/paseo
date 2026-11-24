import { useTranslation } from "react-i18next";
import { en } from "@/i18n/resources/en";
import type { ReviewErrorCode } from "./port";

export const reviewGuideEnglish = en.workspace.git.pr.reviewGuide;

type ReviewGuideCopyKey = keyof typeof reviewGuideEnglish;
type ReviewGuideCopyValues = Record<string, string | number>;

export function useReviewGuideCopy() {
  const { t } = useTranslation();
  return (key: ReviewGuideCopyKey, values?: ReviewGuideCopyValues): string =>
    t(`workspace.git.pr.reviewGuide.${key}`, { defaultValue: reviewGuideEnglish[key], ...values });
}

export const reviewErrorCopy: Record<ReviewErrorCode, ReviewGuideCopyKey> = {
  stale: "errorStale",
  permission: "errorPermission",
  unsupported: "errorUnsupported",
  unavailable: "errorUnavailable",
  unknown_outcome: "errorUnknown",
  invalid_target: "errorInvalidTarget",
  expired: "errorExpired",
};
