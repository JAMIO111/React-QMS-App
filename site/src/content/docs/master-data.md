---
title: Master data
summary: Keep parts, revisions, families, machines, customers, suppliers and employees in one place the rest of Fortress draws on.
group: Admin and security
order: 41
---
Master data is the reference list the other modules pick from. Under **Master Data** in the side menu you will find **Overview**, **Parts**, **Part Families**, **Machines**, **Customers**, **Suppliers** and **Employees**. People who may manage master data can add and edit. Everyone else can read.

Records are never deleted. A record you no longer use is made inactive, and inactive ones drop out of pickers. Each register has a **Show inactive** switch.

## Parts and revisions

Choose **Add part** and give a part number, a name, and optionally a description, a revision and a drawing reference. If you leave the revision empty you can add revisions later. A part can sit in one **part family**.

A part's revisions go through a short life:

1. **Draft**: you can edit it. Use **Add revision** with the revision letter, drawing reference and what changed.
2. **Released**: choose **Release**. It becomes the current revision and can no longer be edited. The revision that was current is marked superseded.
3. **Obsolete**: choose **Obsolete** when a revision should no longer be used for new inspections or records. This cannot be undone.

The part page also holds **Customers** (who buys the part, with each customer's own part number, and one primary customer), **Specification values** (nominals and limits kept per revision, used by variable checks in family control plans) and the **Inspection requirements** that apply from its released revision.

### Correcting a released revision

If the drawing and your record of a released revision disagree, do not raise a new letter. Choose **Correct** on the released row and say what is wrong. Fortress makes a draft of the next version with the same values, shown as, for example, "B v2". Edit it, then **Approve and release** it. Releasing a correction needs someone who may approve control plans. The old version stays on record, marked corrected.

Inspections and non-conformances already made keep the exact version they used. New inspections use the corrected values. The approval dialog shows how many inspections and non-conformances used the version being replaced. Correcting a revision that has already been superseded is not supported.

## Part families

A family groups parts so one control plan can cover them. Choose **Add part family** with a code and a name, then add parts to it from the family page. The page also lists the control plans whose scope includes the family. A plan written for one part overrides a family plan.

## Machines

A machine has a code, a name, a site and optionally a work centre or line. Machines are what you pick for **Where detected**, **Causal process** and jobs. Switch **Active** off to hide a machine from pickers.

## Customers and suppliers

Both have a code, a name, a company number, a VAT number, a company email, phone and website, a full address, and a **currency**. The currency is information only: totals stay in your base currency. The email, phone and website are the company's general line. Named people go under **Contacts**, with one marked primary, in the customer's edit dialog.

The **Suppliers** entry opens the supplier register, which also carries approval status, risk and performance. See [Suppliers](/help/suppliers).

## Employees

The register holds people who work for you, whether or not they use Fortress. Each has a name, an employee number (unique, any case), a work email, a job title, a site and a department. Choosing a department fills the site. People are deactivated, not deleted. The employee picker on a non-conformance, and the audit and competence screens, use this register.

Linking an employee to a sign-in is a separate step in the **Sign-in account** section. Only people holding a Controller seat can do it. The person must be an active member, and a sign-in can be linked to one employee only.

## Overview

**Master Data → Overview** shows how many records of each kind you hold, records added each week, parts by family, machines by site, employees by department and part revisions by status. It also runs data-quality checks over active records: parts with no released revision, family or customer, machines with no site, and employees with no department. Zero means healthy. People who may see integrations also see counts of import health.

## Good to know

- A field that a scheduled import owns shows a lock and cannot be edited by hand. See [Import your data](/help/import-your-data).
- Units of measure are a fixed list. They appear in pickers, but there is no screen to edit them.
- There is no customer profile page yet: customers are edited in a dialog.
- For extra fields of your own on any of these records, see [Custom fields](/help/custom-fields).
