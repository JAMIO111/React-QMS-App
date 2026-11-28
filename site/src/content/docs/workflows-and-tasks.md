---
title: Workflows and tasks
summary: Write rules that tell people or give someone a task when something happens, test them, and work through the tasks you are given.
group: Admin and security
order: 46
---
A workflow rule says: **when** this happens, **if** these conditions hold, **then** tell people or give someone a task. For example, tell the quality manager when a major non-conformance is raised, or give the cell leader a task when a critical check fails.

Rules never change a record themselves. They only tell people, give tasks, and (in one case) hold a lot.

## Where rules live

Rules are under **Settings → Workflows**. People who may read workflows can see them. People who may manage workflows can write, change and test them. Each rule has a reference such as WF-001, a status (active, paused or retired), a version and a count of runs.

Choose **New rule** to start.

## When: what starts the rule

Under **When**, choose what starts the rule. There are 35 triggers, grouped by area. They include a non-conformance being raised or moving stage, a disposition being approved, an inspection reading failing, an SPC alert, a calibration being recorded, a gauge changing status, an 8D being started, verified or closed, an audit completing, an audit finding, supplier approval, risk and scorecard changes, a SCAR changing status, a received line decision, a risk being assessed, a Gauge R&R study completing, changes, FMEA and PPAP events, and a quality alert being issued.

## If: the conditions

Under **If**, add conditions that test facts about the record, such as severity, stage, part, supplier or total cost. Choose whether **All of these** or **Any of these** must hold. The tests offered depend on the field: for example "is", "is one of", "is at least", "contains" or "is empty". With no conditions the rule runs every time.

Changing what starts the rule removes its conditions, because they test the old record. Fortress asks you first.

## Then: the actions

You can add up to ten actions.

- **Tell people**: write a message and choose who gets it: the record's owner, a person, everyone with a role, or everyone in a department. Only people who may read the record are told. Notices appear in the bell, and are emailed by default.
- **Give a task**: choose who gets it (a person, or the record's owner), a title, optional detail and how many days it is due in.
- **Hold the lot**: for rules about non-conformances, dispositions and inspection readings, which can name a lot. The lot is put on hold with a reason, using the authority of whoever saves this version of the rule. If that person may no longer hold lots at that site, nothing is held and they are told.
- **Later, if still…**: after a number of days, Fortress looks at the record again, checks the conditions you set for that step, and only then does up to five actions.

## Test the rule

Before relying on a rule, use **Test the rule** on its page. Choose a recent event that you may read, from the last 90 days. Fortress shows which conditions hold, whether the rule would run, and who each action would reach, including people it would not tell because they may not read the record. Nothing is saved or sent.

## Save, versions and status

A new rule is saved with **Save and turn on**. After that, a change to what starts it, what it tests or what it does is saved as a **new version**, and you must say why. A change to the name or description does not make a version. The **Versions** card shows what the rule did at each version and why it changed. **What it did** lists the latest runs: which version ran, for which record, and what each action did.

A rule can be **Paused** (it does not run until resumed) or **Retired** with a reason, and later **Brought back**.

Rules are worked through by the background worker, so a notice or task can arrive a few minutes after the event, and each rule runs once for each event.

## My tasks

**My tasks** is second in the side menu for everyone, with a count of open tasks. Each task names the record it is about and the rule that made it. Choose **Mark done** to finish it, with an optional note of what was done. Switch between **Open**, **Done** and **All**, and **Reopen** a finished task. You do not need any workflow permission to receive a task. You can only be given a task about a record you may read.

## Good to know

- A task is a prompt for a person. Finishing it does not move the record, and rules cannot close or approve anything.
- For reminders about your own overdue work, see [Notifications and reminders](/help/notifications-and-reminders).
