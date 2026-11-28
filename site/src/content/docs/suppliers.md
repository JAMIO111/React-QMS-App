---
title: Supplier quality
summary: Keep a register of suppliers, approve them properly, track certificates and risk, and see how each one performs.
group: Suppliers and customers
order: 30
---
Supplier Quality holds one record for each supplier: who they are, whether they are approved, what they are certified to, how risky they are and how they perform. Nothing here changes by itself. People decide, and Fortress keeps the history.

## The register and profile

Open **Supplier Quality → Supplier register** and choose **Add supplier**. A new supplier always starts as **Pending approval**. Open one to see its profile, with tabs for **Overview**, **Performance**, **Qualification**, **Incoming quality**, **Nonconformities**, **SCARs**, **Audits**, **Documents**, **Products & services** and **History**.

Company email, phone and website are the company's general lines. Named people go under **Contacts**, with one marked primary. **Products & services** lists the parts of yours the supplier provides, and materials or services in words.

## Approval status

The status is one of Pending approval, Approved, Conditional approval, Suspended, Disqualified or Archived. Every change needs a reason and is kept in **History**.

- **Suspend, disqualify, archive or re-open:** use **Change approval status** on the profile.
- **Approve or approve conditionally:** one person proposes it and someone else decides. On the **Qualification** tab choose **Propose approval**, then another person with approval rights chooses **Decide**. Nobody decides their own proposal.

A proposal should rest on a passing assessment. Without one you must give an exception reason of at least 10 characters, which is kept with the decision. A conditional approval needs its conditions written down.

## Assessments, certificates and documents

Under **Qualification**, **Start assessment** gives a questionnaire. Fortress works out pass or fail from the answers. A failed critical question fails the assessment, and a completed one is frozen. Questionnaires are managed under **Settings → Data Management → Supplier quality**.

**Add certification** records a standard, certificate number, issuing body and expiry date. **Verify** it once you have checked it; after that it can only be renewed. **Add document** on the **Documents** tab stores files, and a new version replaces the old one.

Expiry is shown as valid, expiring within 60 days or expired. It never changes the approval status. **Supplier Quality → Expiry watchlist** lists what has expired or is about to.

## Risk

On **Qualification**, **Assess risk** (or **Assess again**) has you score each factor from low to critical and give a rationale. Fortress works out the rating, and only an assessment sets it. A factor marked as raising the rating lifts the result to at least high when scored critical. A review date is kept and flagged when overdue. The factors are set under **Settings → Data Management → Supplier quality**.

## Performance

The **Performance** tab covers 30 days, 90 days or 12 months. It works out on-time and in-full delivery, PPM, lot rejection, non-conformances, SCAR response and certificate standing, then gives a band: Good, Watch, Poor or Not enough data. **Save as a scorecard** freezes it. The same settings page can save scorecards every month, quarter or year.

**Supplier watchlist** lists suppliers that are Poor, on Watch or carrying a warning, worst first. **Supplier Quality → Dashboard** shows the whole picture for a period.

## Inspection recommendation

The **Incoming quality** tab suggests an inspection level (increase, normal or reduce) from risk, status and performance. It is advice only. Use **Write a requirement** to act on it; see [Receiving and incoming inspection](/help/receiving-and-incoming-inspection).

## Good to know

- Scores need enough data. A metric with none is left out, and under half the weight means no score.
- Expiry and risk reviews are shown in the app. Email reminders for them are not built.
- Raise corrective actions in [Supplier corrective actions](/help/supplier-corrective-actions).
