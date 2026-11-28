---
title: Power BI and reporting
summary: Make a read-only reporting key and load your non-conformance and supplier quality data into Power BI on a schedule.
group: Admin and security
order: 52
---
If you build reports in Power BI, you do not need to export files. A **reporting key** lets Power BI read your Fortress data on a schedule, without a person signing in each time. This guide covers making a key and connecting Power BI. Bringing data into Fortress is covered in [Connect an API](/help/connect-an-api) and [The connector agent](/help/connector-agent).

Making and revoking keys needs a Controller seat and a role that allows integrations. Anyone who can see integrations can see the list of keys.

## What a key is

A key acts as **the person who made it**, and it can only read. A report sees exactly what that person may see: their roles, their sites and every record rule that applies to them. The key stops working when that person is suspended, removed or loses their seat, or when the key expires or is revoked. It also obeys your organisation's network rule, so a key used from an address you have not allowed is refused.

A key can do one thing: read the reporting datasets. It cannot write anything, make other keys or read the rest of Fortress. Fortress keeps only a fingerprint of the key, never the key itself, and each key records when and from where it was last used.

## Make a key

1. Open **Settings → Integrations** and find **Power BI and reporting**.
2. Choose **Make a key**.
3. Give it a name, such as the report it is for, and choose how long it lasts: 90 days, 180 days, 1 year (recommended) or 2 years.
4. Choose **Make the key**, then copy it. **It is shown once.** If you lose it, revoke it and make a new one.

An organisation can hold ten live keys at a time. If your organisation pays by invoice, **Make a key** waits until your first invoice has been paid.

## Connect Power BI

Choose **Connect Power BI** on the same card. It shows the Fortress address, the steps, and a ready-made Power Query script for each dataset.

1. In **Power BI Desktop**, choose Get data, then **Blank query**, then **Advanced editor**, and paste the script.
2. When Power BI asks how to sign in, choose **Basic**. Use any user name, for example `powerbi`, and the key as the password. The key is not written into the script, so you can share the report file safely.
3. Check that the table loads, then close and apply.
4. Publish the report. In the **Power BI service**, open the dataset's settings, enter the same Basic credentials and set a refresh schedule.

The script reads the data a page at a time, up to 5,000 rows a page, and gives each column its type. Power BI keeps its own copy of what it imports, in the region its tenant uses.

## The datasets

| Dataset | One row per | Needs permission to read |
| --- | --- | --- |
| Non-conformances | non-conformance (deleted ones left out), with its total cost | non-conformances |
| Non-conformance costs | cost line | non-conformances |
| Suppliers | supplier | supplier quality |
| Supplier corrective action requests | request that has been issued (drafts left out) | supplier quality |
| Goods receipt lines | received line, with its latest incoming inspection decision | receiving |
| Supplier scorecards | saved scorecard, whether saved by hand or on a schedule | supplier quality |

Costs are in your organisation currency. Credits, such as supplier recoveries, are negative amounts, so a sum comes out right. A cost line still waiting for an exchange rate has no converted amount. Link tables by their Fortress id columns. The list of datasets and columns in the Connect Power BI window is exact, and a person without permission for a dataset gets a refusal for it.

## Expiry and revoking

Each key shows its prefix, who it acts as, when it expires and when it was last used. Before it expires, make a new key, put it into the report's credentials, then revoke the old one.

To revoke a key, choose **Revoke** and give a reason. Any report using it stops refreshing at once. This cannot be undone. Revoked and expired keys stay listed under **Past keys**, and keys are never deleted.

## Good to know

- Only the six datasets above are available. Inspections, measurements, 8Ds, audits, risks and calibration are not.
- This is new. Check the first refresh against the non-conformance register, and make a key as someone with fewer site rights to confirm they see fewer rows.
- Changing a part or supplier name does not move the rows that show it, so a full refresh picks up the change.
