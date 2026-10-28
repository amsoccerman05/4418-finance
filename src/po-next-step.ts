import type { Data, PO } from "./service";

/** Presentation only. These destinations never submit or authorize an action. */
export type PONextStep = {
  title: string;
  description: string;
  target: "owner-actions" | "approval-po_approver" | "approval-finance_approver" | "school-submission" | "receiving" | null;
  actionLabel: string | null;
};

const approvalSlots = ["po_approver", "finance_approver"] as const;
const slotName = (slot: typeof approvalSlots[number]) =>
  slot === "finance_approver" ? "Finance Lead" : "Lead Coach";

export const selfApprovalGuidance = "You requested this PO, so you cannot approve it yourself. Ask a different mentor or admin who has not already approved this revision to review it using the existing override process. An explicit override reason and two different approvers are still required.";

/** A visibility explanation, never an authorization for the requester to act. */
export function selfApprovalBlocked(d: Data, p: PO): boolean {
  return p.status === "awaiting_approval" &&
    p.requester_id === d.context.profile.id &&
    !["admin", "mentor"].includes(d.context.profile.role) &&
    approvalSlots.some(slot => d.context.capabilities.includes(slot) &&
      !d.approvals.some(a => a.po_id === p.id && a.revision === p.revision &&
        a.slot === slot && a.action === "approved"));
}

/**
 * Explain the next step using the same role, revision and two-person checks as
 * Detail. The server remains the authority for every mutation; do not use this
 * helper as an authorization predicate.
 */
export function poNextStep(d: Data, p: PO): PONextStep {
  const viewer = d.context.profile.id;
  const requester = p.requester_id === viewer;
  const owner = requester || d.context.is_admin;
  const canOverride = ["admin", "mentor"].includes(d.context.profile.role);
  const canSubmitOrReceive = canOverride || d.context.capabilities.includes("school_submitter");

  switch (p.status) {
    case "draft":
      return owner ? {
        title: "Finish and submit this request",
        description: "Resume the draft, check the Google Sheet and request details, then submit for approval. Saving a draft does not submit it.",
        target: "owner-actions",
        actionLabel: "Review draft actions",
      } : {
        title: "Waiting for the requester",
        description: "The requester must finish this draft and submit it before approvals can begin.",
        target: null,
        actionLabel: null,
      };
    case "changes_requested":
      return owner ? {
        title: "Update and resubmit this request",
        description: "Read the requested changes below, update the Google Sheet and purchase order, then resubmit for both approvals.",
        target: "owner-actions",
        actionLabel: "Review request actions",
      } : {
        title: "Waiting for the requester to make changes",
        description: "The requester must address the review comments and resubmit this request before both approvals can be completed.",
        target: null,
        actionLabel: null,
      };
    case "awaiting_approval": {
      const approvals = d.approvals.filter(a =>
        a.po_id === p.id && a.revision === p.revision && a.action === "approved");
      const pending = approvalSlots.filter(slot => !approvals.some(a => a.slot === slot));
      if (!pending.length) return {
        title: "Check the latest approval status",
        description: "Both approvals are recorded. Refresh Finance to check the latest status before sending the request to school.",
        target: "approval-po_approver",
        actionLabel: "View approvals",
      };
      const waiting = pending.map(slotName).join(" and ");
      const waitingTarget = `approval-${pending[0]}` as PONextStep["target"];
      if (approvals.some(a => a.actor_id === viewer)) return {
        title: "Waiting for another approver",
        description: `Waiting for ${waiting}. You already approved this submission; a different person must complete the remaining approval.`,
        target: waitingTarget,
        actionLabel: "View approval status",
      };
      if (selfApprovalBlocked(d, p)) return {
        title: "A mentor must review your request",
        description: `${selfApprovalGuidance} Waiting for ${waiting}.`,
        target: waitingTarget,
        actionLabel: "View approval status",
      };
      const assigned = pending.find(slot => d.context.capabilities.includes(slot));
      const actionable = (!requester || canOverride) && (assigned || (canOverride ? pending[0] : undefined));
      if (actionable) {
        const overrideRequired = requester || !d.context.capabilities.includes(actionable);
        return {
          title: overrideRequired ? `Review the ${slotName(actionable)} approval with an override` : `Review the ${slotName(actionable)} approval`,
          description: overrideRequired
            ? `Review the submitted Google Sheet. An override reason is required because you ${requester ? "requested this PO" : "are not assigned this approval"}. Two different people must approve each submission.`
            : actionable === "finance_approver"
              ? "Review the submitted Google Sheet and budget coding, then approve or request changes below. Two different people must approve each submission."
              : "Review the submitted Google Sheet, then approve or request changes below. Two different people must approve each submission.",
          target: `approval-${actionable}`,
          actionLabel: "Review approval",
        };
      }
      return {
        title: `Waiting for ${waiting}`,
        description: "The submitted Google Sheet is being reviewed. Both approvals are required before it can be sent to school.",
        target: waitingTarget,
        actionLabel: "View approval status",
      };
    }
    case "approved":
      return canSubmitOrReceive ? {
        title: "Send the approved Sheet to school",
        description: "Send the approved Google Sheet to school, then record that submission below. Marking it submitted does not send the document for you.",
        target: "school-submission",
        actionLabel: "Review submission",
      } : {
        title: "Waiting for school submission",
        description: "A designated school submitter or mentor/admin must send the approved Google Sheet to school and record the submission.",
        target: "school-submission",
        actionLabel: "View submission status",
      };
    case "submitted_to_school":
      return canSubmitOrReceive ? {
        title: "Confirm delivery when everything arrives",
        description: "Once the entire order has arrived, mark it received below. This records delivery without changing Inventory stock or adding another expense.",
        target: "receiving",
        actionLabel: "Review receiving",
      } : {
        title: "Waiting for delivery confirmation",
        description: "A designated school submitter or mentor/admin can mark this received once the entire order has arrived.",
        target: "receiving",
        actionLabel: "View receiving status",
      };
    case "received":
      return {
        title: "Purchase order complete",
        description: "Delivery has been recorded. No further approval, school-submission or receiving action is needed for this purchase order.",
        target: "receiving",
        actionLabel: "View receiving record",
      };
    case "cancelled":
      return {
        title: "Request cancelled",
        description: "No further action is needed for this request. It cannot be submitted or marked received.",
        target: null,
        actionLabel: null,
      };
    default:
      return {
        title: "Check this purchase order",
        description: "Review its current status and activity history. Refresh Finance if the status is unexpected.",
        target: null,
        actionLabel: null,
      };
  }
}
