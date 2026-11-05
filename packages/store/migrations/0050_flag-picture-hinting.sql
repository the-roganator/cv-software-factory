-- The probes' browser sets text unhinted (`--font-render-hinting=none`), as Chrome on a desktop does; before, it hinted
-- fully, as headless Chromium on Linux does by default, which snaps each glyph's advance to a whole pixel. A page set one
-- way differs from the same page set the other along every line of text, which is no change to the app, so each picture
-- names how its text was set, and a page with the flag on is compared only with the page with it off set the same way.
-- One that does not say was taken by the hinting browser: every picture taken before, and any the probes of an earlier
-- image insert, as they still do while the new image starts and would again after a rollback. So the default stays,
-- and their inserts keep working; the probes of this image always name it.
alter table flag_pictures
  add column hinting text not null default 'full' check (hinting in ('full', 'none'));
alter table flag_pictures drop constraint flag_pictures_pkey;
alter table flag_pictures add primary key (flag, stage, revision, version, path, scheme, hinting);

grant insert (hinting) on flag_pictures to factory_probes;
