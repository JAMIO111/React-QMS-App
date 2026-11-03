-- Organisation theme colour: the accent colour the app uses for this organisation
-- (buttons, highlights, active states). Purple is the default so existing organisations look
-- unchanged. organisation_settings is already audited (audit_changes) and covered by RLS: only
-- members with organisation.manage can update it.
ALTER TABLE public.organisation_settings
  ADD COLUMN theme_colour text NOT NULL DEFAULT 'purple'
    CONSTRAINT organisation_settings_theme_colour_check
    CHECK (theme_colour IN ('blue', 'red', 'yellow', 'green', 'orange', 'purple', 'pink'));

-- Updates are granted column by column (20251103100200_rls_lockdown.sql); RLS still limits them
-- to members holding organisation.manage.
GRANT UPDATE (theme_colour) ON public.organisation_settings TO authenticated;
