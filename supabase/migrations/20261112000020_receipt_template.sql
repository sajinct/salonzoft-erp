-- =============================================================================
-- Salonzoft · Migration 0020 · Receipt / invoice print template per salon
-- -----------------------------------------------------------------------------
-- Each salon chooses how its invoices print: paper (A4 or 80 mm / 58 mm thermal
-- roll), language (English, Arabic or both), a free-text header in each
-- language (address, phone, CR number …), whether the logo is printed, and
-- whether the receipt prints straight after a payment at the POS.
-- The footer columns (receipt_footer_en / _ar) already exist.
-- =============================================================================

alter table public.tenant_settings
  add column receipt_header_en  text check (char_length(receipt_header_en) <= 500),
  add column receipt_header_ar  text check (char_length(receipt_header_ar) <= 500),
  add column receipt_paper      text not null default 'a4' check (receipt_paper in ('a4', '80mm', '58mm')),
  add column receipt_language   text not null default 'both' check (receipt_language in ('en', 'ar', 'both')),
  add column receipt_show_logo  boolean not null default true,
  add column receipt_auto_print boolean not null default false;

-- Same rule as the other settings: RLS limits updates to settings.manage.
grant update (receipt_header_en, receipt_header_ar, receipt_paper, receipt_language, receipt_show_logo, receipt_auto_print)
  on public.tenant_settings to authenticated;
