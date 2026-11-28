---
title: Organisation settings
summary: Set up your organisation's details, sites, currency, reminders and the module lists, and find your own account settings.
group: Admin and security
order: 40
---
Most set-up lives under **Settings**. This guide covers the pages that describe your organisation as a whole. People who may manage the organisation can change them. Everyone else can view them.

## Settings → Organisation

The page is a stack of cards.

- **Details**: name, legal name (used on documents and invoices), a two-letter country code such as GB, base currency, VAT rate and the prefix for new non-conformance numbers. The identifier is fixed when the organisation is created. You can add a reason for a change, which goes in the audit trail.
- **Logo**: upload a PNG, JPG, WebP or SVG image of 1 MB or less. It shows at the top of the side menu for everyone. You can replace or remove it.
- **Theme colour**: choose one of blue, red, yellow, green, orange, purple or pink. Buttons, highlights and active items use it for everyone, in light and dark mode.
- **Security**: a pointer to **Settings → Security**, where two-factor and network rules live. See [Security and sign-in](/help/security-and-sign-in).
- **Daily reminders**: the time the reminders go out (in 15-minute steps) and the time zone the organisation's day is kept in. If you leave the zone empty, the first site's zone is used. See [Notifications and reminders](/help/notifications-and-reminders).
- **Production**: three switches. Track lots and serial numbers (off hides them from the menu and pickers, and deletes nothing). Let operators make an order from a job. Require a production order to complete a job. A **Link existing records** section can preview, then link, work orders, lots and serial numbers that were typed as text on older inspections and non-conformances.
- **Sites and departments**.
- **Costs stated in another currency**: appears only when there is something to restate.

### Sites and departments

A site is a place where work happens. Departments are the teams or areas inside it. Choose **Add site** and give it a code, a name, a time zone and a currency. A new site starts with the organisation's currency. Costs at a site are stated in the site's currency, and its currency cannot change once costs have been recorded there. The site's departments can be added in the same pop-up or later from the site's card.

A site with no departments offers quick-add buttons for Quality, Production, Warehouse and Engineering. Nothing is deleted: use **Deactivate** on a site or on a department chip, and **Reactivate** to bring it back.

### Currency and costs

The organisation's base currency is the one totals are shown in. Costs on a non-conformance are stated in its site's currency, and Fortress looks up a published exchange rate for the day the cost was incurred. If sites were given their own currency after costs already existed, **Costs stated in another currency** lists the sites affected. **Restate…** converts those lines at published rates and marks them as estimates. The organisation-wide figures do not change. The organisation's currency cannot be changed once non-conformance costs exist.

## Settings → System Preferences

Two switches for people who manage the organisation:

- **Include legacy calibrations** in the calibration dashboard's period figures. Off by default. See [Calibration](/help/calibration).
- **Let the person who raised a change sign it off too**. Off by default. See [Change management](/help/change-management).

## Settings → Data Management

One tab for each module's lists. A tab shows only if you may read that module, and you can change it only if you may manage it. The tabs are Non-conformance, Calibration, Process control, Audits, Supplier quality, Competence, Documents, Risk, FMEA, PPAP, Change and Custom fields. The tab you are on is in the address, so you can share a link to it. Entries are switched off rather than deleted, so history is kept.

Master data, such as parts and machines, is not here. It is in the **Master Data** menu: see [Master data](/help/master-data). For your own extra fields, see [Custom fields](/help/custom-fields).

## Settings → Account

This page is about you, not the organisation. You can set your profile picture, first name, surname and job title. Your email is your sign-in address and is read-only. You can also turn two-factor authentication on or off and change your password: you enter your current password first.

There is no delete button for accounts, because quality records are never deleted. An administrator suspends or removes a person under **Settings → Users & permissions**, and their name stays on the records they made.
