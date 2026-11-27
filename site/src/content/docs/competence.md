---
title: Competence
summary: Record who can do what, assess people against their positions and keep training as evidence.
group: Quality system
order: 28
---
The Competence module shows who is competent at what, and where there are gaps. It is information only: it never stops anyone doing a job.

## Levels

Every skill is rated on one scale: 0 none, 1 learning, 2 supervised, 3 competent, 4 can train others. People come from the Employees register, so a person does not need a sign-in to be assessed.

## Set up skills and positions

Open **Settings → Data Management → Competence**. Add **skills**, each with a code, a name, a category and, if it needs reassessing, a refresh interval in months. Add **positions** and choose **Required skills** for each, with the level required. Skills and positions are retired with a reason, never deleted, and a skill an active position requires cannot be retired. **Competence → Skills and positions** shows the same list read-only.

## Give people positions

Open a person from the matrix (or **Competence → Skills matrix** then the name) and choose **Give a position**, with a start date. **End** a position when it stops applying. The page then shows which skills they need and where they stand.

## Record an assessment

On the person's page choose **Record an assessment**. Pick the skill and level and the date. The expiry follows the skill's refresh interval unless you set one. Rules the database holds:

- You cannot assess yourself.
- Level 4 also needs permission to manage competence.
- A lower level than before needs a note.
- A new assessment replaces the old one, which stays in the history.

Fortress works out status on screen: **gap**, **not assessed**, **expired**, **expiring** (within 60 days) or **ok**. Expiry never lowers a level.

The person is told "You were assessed" if their employee record is linked to a sign-in. The Employees register is where that link is made, by people who hold a Controller seat.

## Skills matrix

**Competence → Skills matrix** is a grid of people by skills, tinted against what their positions need. Filter by position, department, site, category, skill or status, and search by name. **Export CSV** writes the whole filtered matrix, with the figures explained at the top of the file.

## Training sessions

**Competence → Training sessions → New session**: a course, on-the-job, external, induction or other. Name an internal trainer from the Employees register, or an external provider as text. Add the people and the skills it supports, then select the attendees and **Record a result** (completed, failed or absent, with their own date). Attach certificates to the session or to a person, then close it once nobody is still enrolled. A recorded result is voided with a reason, not edited.

Training is evidence. It does not set anyone's level: you still record an assessment.

## Your own record

**Competence → My competence** shows your positions, skills, training and documents you have read. It works for anyone whose sign-in is linked to an employee record, whatever their role. If it is not linked, the page says so.

## Dashboard

**Competence → Dashboard** shows people with gaps, assessments expired or expiring in 30, 60 and 90 days, people never assessed, the skills most often short, and training results for the period. Pick the period at the top.

## Good to know

- Seeing everyone's competence needs permission to read competence. Holders of a Controller seat can read it too.
- Email or push for expiry is not built. The in-app reminders cover the person's own expiring skills (see [Notifications and reminders](/help/notifications-and-reminders)).
