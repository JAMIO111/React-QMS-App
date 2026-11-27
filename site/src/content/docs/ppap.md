---
title: PPAP
summary: Prepare a part approval package for a customer, record their decision, and handle packages from your suppliers.
group: Quality system
order: 27
---
A PPAP is the evidence a customer wants before they accept a part. Fortress keeps one submission per part revision and customer, with the 18 elements, a Part Submission Warrant and the customer's decision. It informs and never blocks: nothing stops production because a PPAP is missing.

## Set the rules first

Open **Settings → Data Management → PPAP**. The requirement set says, for each of the five levels, which elements you send, which you keep and which are not needed. It also holds minimum capability and gauge study figures. Fortress ships it neutral because customer manuals are the publishers' own, so check it against yours. Changing it needs approval rights. You can also set a customer's usual level, extra elements and own minimums.

## Start a submission

Choose **PPAP → Part approvals → Start a submission**, or **Start a PPAP** on a part page, a change page or a control plan revision page. These show "PPAP likely needed" for customers who have asked you for PPAP before. Choose the part and revision, the customer, the level and the reason.

Pick **A supplier sent it to us** instead to record a package you received. See below.

## Prepare the elements

Each element can take files, and links to live records: the control plan, FMEA, gauge R&R study, inspection, material certificate, calibration, document and so on, depending on the element. Fortress shows whether a linked record is in good standing, and checks the figures against your minimums. Mark each element **Ready**. People with approval rights can **Waive** one with a reason of at least ten characters.

The **Still needed** list says what blocks **Mark ready**.

## The warrant

Type the Part Submission Warrant on the page. An approver signs it. The person who prepared it, and the owner, cannot. An approver can take a signature off with a reason while you are still preparing.

## Send and record the answer

**Send to the customer** records the day and how it went, and freezes the links and the warrant. Then use **Record the customer's decision**: approved, approved for now (interim, with an end date and conditions) or rejected (with the reason). The history is never edited.

You can also **Ask the customer** to answer in the portal. Their answer becomes the decision. See [The supplier and customer portal](/help/supplier-and-customer-portal).

An interim approval that has run out stays interim until a new decision is recorded. **Resubmit** after a rejection. **Revalidate with a new submission** after an approval, or **Record a review** with a note and next date.

## Packages from suppliers

For a received package the supplier's own signed warrant is a file on that element. You can **Ask the supplier** to prepare and submit it in the portal, or add the files yourself and **Record as received**. **Record our decision** works like the customer's. The supplier's profile has a part approvals tab and an interim approval that runs out appears on the expiry watchlist. Neither changes the supplier's approval status.

## Dashboard

**PPAP → Dashboard** shows what is waiting, approved, interim, rejected or due a review.
