-- The probes' browser sets text unhinted (`--font-render-hinting=none`), as Chrome on a desktop does; before, it hinted
-- fully, as headless Chromium on Linux does by default, which snaps each glyph's advance to a whole pixel. A page set one
-- way differs from the same page set the other along every line of text, which is no change to the app, so each picture
-- names how its text was set, and a page with the flag on is compared only with the page with it off set the same way.
-- One taken before was hinted fully.
alter table flag_pictures
  add column hinting text not null default 'full' check (hinting in ('full', 'none'));
-- Every picture from now on says how it was set.
alter table flag_pictures alter column hinting drop default;
alter table flag_pictures drop constraint flag_pictures_pkey;
alter table flag_pictures add primary key (flag, stage, revision, version, path, scheme, hinting);

grant insert (hinting) on flag_pictures to factory_probes;
