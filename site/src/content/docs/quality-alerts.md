---
title: Quality alerts
summary: Tell the right people about a quality problem, record that they acknowledged it, and show it where the work happens.
group: Quality system
order: 22
---
A quality alert says that something needs attention now, for example a wrong material specification on a lot of bar stock. You address it to departments, roles or named people. Fortress records who was asked, who has seen it and who has acknowledged it. While it is in force it also shows on the screens where the affected work is done. Alerts inform. They never block anyone.

## Draft an alert

Open **Documentation → Quality alerts** and choose **New quality alert**. You need the right to manage alerts to draft one.

1. Give it a **Title**, a **Category** (Product, Process, Supplier, Equipment or Safety) and a **Severity** (Low, Medium, High or Critical).
2. Write the **Description** and an **Effective date**. An **Expiry date** is optional.
3. Under **Required actions**, add one line per action. Each can be for a department, a machine or everyone.
4. Under **What it affects**, add parts, part families, machines or operation codes. This is how the alert is found where people work.
5. Under **Related records**, optionally link the non-conformance, supplier, gauge or calibration it is about. Add files if you have them.
6. Under **Who must acknowledge**, choose departments, roles or named people.

Choose **Save draft**. You can come back and **Edit** or **Discard** it.

## Issue it

On the draft, the page shows **Who will be asked**: how many people each choice reaches. Nobody reached means it cannot be issued. To issue you need at least one action, an effective date and at least one person reached. High and critical alerts also need an **Acknowledge by** date.

Choose **Issue alert**. This needs the right to issue alerts. Once issued, the content is frozen. The list of people asked is fixed at that moment, and each of them gets an in-app notice.

## Acknowledging

People addressed by an alert find it under **Documentation → My alerts**. They open it, read what to do and choose **Acknowledge**, with an optional note. It is recorded with their name and the time and cannot be changed. An alert is overdue for someone when the acknowledge-by date has passed and they have not acknowledged.

Managers see the **Acknowledgements** card on the alert: how many were asked, viewed, acknowledged and overdue. They can filter by who has not acknowledged, filter by department, and use **Add** to ask one more person later. The register can also be filtered to overdue alerts.

## Changing an alert

- **Issue a revision** makes a draft copy with a reason. The current revision stays in force until the new one is issued, then it is superseded. Everyone is asked again.
- **Withdraw** takes an alert out of force, with a reason. It stays on record and the people asked are told.
- **Expiry** is automatic. After its expiry date an alert shows as Expired and no longer appears where people work. **Reopen** it with a new expiry date and a reason if it still applies. The expiry history is on the alert.

## Where people see it

Alerts in force appear in a banner on **Start inspection**, on part, part family and machine pages, and in the **Alerts** pane of a job. A part also matches its part family. The banner lists the required actions and says whether you have acknowledged.

## Good to know

- The notice you get when an alert is addressed to you can be switched off, or sent by email, in **Settings → Notifications**. Alerts you still have to acknowledge also appear in your daily reminders (see [Notifications and reminders](/help/notifications-and-reminders)).
- You can share an alert in force with a supplier or customer who has portal access, and they can acknowledge it there. See [Supplier and customer portal](/help/supplier-and-customer-portal).
- Alerts can link to records, but they are not created from them automatically.
