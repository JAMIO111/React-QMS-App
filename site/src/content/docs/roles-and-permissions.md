---
title: Roles and permissions
summary: Understand the built-in roles, make roles of your own, and see how a seat limits what a role gives.
group: Admin and security
order: 43
---
What a person can do in Fortress depends on two things together: their **roles** and their **seat**. A role says what they may do. The seat decides which parts of the product they can use. A role never gives more than the seat allows.

## The built-in roles

Six roles come with every organisation and cannot be changed:

| Role | What it is for |
| --- | --- |
| Owner | Full control of the organisation |
| Admin | Administers the organisation, sites and members |
| Quality manager | Owns quality processes and records |
| Quality engineer | Investigates and maintains quality records |
| Inspector | Records inspections and raises non-conformances |
| Viewer | Read-only access |

Owners, admins and quality managers hold the manage and approve rights in most modules. Quality engineers can read and manage. Inspectors record: they log inspections, raise non-conformances, add files and containment to non-conformances they raised, and record deliveries and shipments. They do not create or change purchase orders and customer orders, move their agreed dates, or acknowledge a failed reading. Viewers read. Only the Owner role can make or change roles.

## Give someone a role

Go to **Settings → Users & permissions**. Each person is a card with a **Roles** section. Choose **Add a role…** and the role is assigned at once. Remove a role with the cross on its chip. A person can hold several roles, and what they may do is the combination.

When you invite someone you choose a role, and optionally **Limited to site**. A role limited to a site applies at that site only. Leave it empty for the whole organisation. Departments are where the person works: they are required unless every role you give is owner, admin or quality manager. See [Invite your team](/help/invite-your-team).

A role assigned to a department only takes effect where a check looks at a department, and no check does yet, so use sites to limit access.

## Make your own role

Go to **Settings → Roles**. This page shows only to Owners. It lists **Your roles** and the **Built-in roles**, with how many permissions each has and how many people hold it.

1. Choose **New role**.
2. Give it a **Name** (up to 60 characters, different from every other role including the built-in ones) and **What it is for** (up to 200).
3. Optionally choose **Start from** to copy an existing role's permissions. You can also choose **Make a copy** on any role in the list.
4. Tick the permissions. They are grouped by module. Each group has **All**, **View only** and **None** shortcuts. Each permission says in words what it allows and which seat it needs.
5. Choose **Make the role**. A role needs at least one permission.

Then assign it on **Settings → Users & permissions** like any other role.

You can have up to 30 roles of your own.

## Rules about roles

- **Owners only.** Nobody else can make, change or delete roles, and the Roles page tells them so.
- **You can only give what you hold.** You cannot put a permission in a role if you do not hold it yourself.
- **Managing roles stays with the Owner role.** A custom role cannot carry it.
- **Changing a role takes effect at once** for everyone who holds it. The dialog tells you how many people that is before you save.
- **Deleting is refused while anyone holds the role.** Take it off those people first. The menu shows the number holding it.
- Changes to roles are recorded in the audit trail.
- If someone else changed the role since you opened it, your save is refused. Close the window and open the role again to see their changes.

## Seats cap what a role gives

There are four seat packages. Observer gives view rights. Operator adds raising non-conformances and recording inspections. Contributor adds the rest of the everyday work, including editing non-conformances and running 8Ds. Controller adds signing off and set-up: approving dispositions, verifying and closing 8Ds, issuing documents and running integrations. A permission that needs a Controller seat has no effect for someone with only a Contributor seat, even if their role includes it. On a person's card, the **Seat** section shows their package. People who manage seats can change it there.

Where seats are enforced, a person with no seat cannot use the product, apart from running the account itself if their role allows. Administration rights such as members, roles, security and billing are never tied to a seat. See [Billing and seats](/help/billing-and-seats).

Integrations need a Controller seat.
