---
title: Notifications and reminders
summary: Choose what reaches your bell and your inbox, and set up the daily reminders of what is overdue or due soon.
group: Admin and security
order: 45
---
Fortress tells you about two kinds of thing. **Notifications** say that something happened. **Reminders** say that something of yours is overdue or due soon. Both are per person, and both are only ever about records you may see.

## The bell

The bell in the header shows how many notifications you have not read. Choose it to open the **Notifications** pane. Switch between **All**, **New** and **Read**, choose **View** to open the record, **Mark as read** on one, or **Mark all as read**. The pane has a **Notification settings** link. The count updates about once a minute.

You are not notified about your own actions. The quality alerts, 8D actions, risk work and similar things given to you personally are sent to you alone.

## Choose what you hear about

Go to **Settings → Notifications**. Everyone has this page. It lists events in groups, one row for each kind of record, with columns for **created**, **updated** and **deleted** where they apply. Each cell has two controls:

- The **switch**: whether it appears in your bell.
- The **envelope**: whether it is also emailed to you. The envelope works only while the switch is on.

Defaults follow your role and your subscription package, and you see only events you have access to. **Reset to defaults** puts your choices back.

## Email

An email is sent for a notification when you have switched the envelope on, or the default for that event is email, and your address is confirmed. By default only notices addressed to you personally are emailed, such as something assigned to you, and the daily reminder. A notification more than a day old is never emailed late. Each email carries the title, the detail and a link to the record.

If your organisation enforces network restrictions, notification emails say only that you have a new notification and link to Fortress, with no details.

If the settings page shows **Emails are not being sent yet**, your choices are saved but the server has no mail service set up, so nothing is emailed until it does.

## Daily reminders

Once a day Fortress tells each person what of theirs is overdue or due soon. It also tells you once when something first goes overdue, for things that went overdue in the last three days. The areas include:

- 8D actions, risk actions and reviews, management review actions
- Containment actions on non-conformances you own
- Audits you are expected to carry out, gauges you look after, Gauge R&R studies
- Documents to read, quality alerts, periodic document reviews
- Supplier corrective action responses
- Your own competence expiring
- Change tasks and sign-offs, FMEA actions and reviews, PPAP interim approvals and reviews

Each area has its own "from N days before" window, shown on the page.

### Choose your areas

Under **Settings → Notifications**, the **Daily reminders** card has a switch for each area. Switch off what you do not want.

### My reminders

**My reminders** is in the profile menu. It lists everything of yours that is overdue or due soon, now, across modules, each with a link. Areas you switched off are still listed, marked **Not reminded**. The daily reminder notice leads here. A day with nothing due sends no digest.

### Reminder time

People who may manage the organisation set when reminders go out in **Settings → Organisation → Daily reminders**: a **Send at** time in 15-minute steps (default 07:00) and the **Time zone** the day is kept in. If no zone is set, the first site's zone is used. "Today", "due soon" and "overdue" are worked out in that zone. A reminder can arrive up to about 15 minutes after the chosen time.

## Good to know

- Reminders are not sent for supplier certificate expiry. The expiry watchlist shows those.
- The time is set for the organisation, not per person, and there is no escalation to managers.
- Workflow rules can also notify people and give them tasks. See [Workflows and tasks](/help/workflows-and-tasks).
