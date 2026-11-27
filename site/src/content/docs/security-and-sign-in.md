---
title: Security and sign-in
summary: Two-factor sign-in, single sign-on, network restrictions and the other controls under Settings → Security.
group: Admin and security
order: 44
---
Everything here lives under **Settings → Security**, for people with security permissions (owners and admins).

## Two-factor sign-in

Turn on **Require two-factor** to make everyone confirm a code from an authenticator app. People without it set up are guided through it when they next sign in.

## Single sign-on (SAML)

Single sign-on lets people use your company account.

1. **Prove your domain.** Add your email domain and create the DNS record Fortress gives you. It re-checks the record weekly.
2. **Connect your identity provider** with its metadata address or file.
3. **Choose how to use it.** Optional lets people choose; required makes it the only way in.

With **required**, nominate up to three **break-glass** owners or admins who can still sign in with a password and two-factor if the identity provider is unavailable. You must be signed in through the provider yourself to switch it on.

You can also let people with your domain **join** automatically as viewers or inspectors, and move existing password accounts across to their company account.

## Network restrictions

Limit access to your office or VPN addresses. Choose **Off**, **Monitor** (nothing is blocked, but attempts from other addresses are recorded) or **Enforce**.

Start in monitor mode. Fortress will not let you enforce a policy that would lock you out: your own address must be on the list. If everyone is locked out anyway, contact us and we can bring the organisation back to monitor mode.

## Who can be invited

Restrict invitations to your email domains. People already outside the list are shown but never removed.

## Sign in again after

Set the longest time a sign-in lasts, from one hour to thirty days, after which people are asked to sign in again.

## Files and the audit trail

Files are private and open through short-lived links. Network restrictions apply to file access too. The audit trail records changes to your data and the settings above.
