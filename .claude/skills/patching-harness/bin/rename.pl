#!/usr/bin/perl -pi
# The copy's name wherever a real one is named: bare, as owner/name, as a regex escapes it, in any case
# (CV-Software-Factory, as tests spell one to be refused), and as a setting's suffix (SCAN_STATE_KEY_CV_…). Left as
# they are: the factory's GHCR mirror of third-party images (…/<factory>/mirror/…), which the cluster and CI pull
# from, and the old owner's names (mrogan/…), which recorded fixtures hold. Given FACTORY, APP, FACTORY_COPY and
# APP_COPY (bare names); each copy is its real name and a suffix.
BEGIN {
  ($f, $p, $fc, $pc) = @ENV{qw(FACTORY APP FACTORY_COPY APP_COPY)};
  ($fs = $fc) =~ s/^\Q$f\E// or die "FACTORY_COPY must begin with FACTORY";
  ($ps = $pc) =~ s/^\Q$p\E// or die "APP_COPY must begin with APP";
  ($F, $P) = map { (my $u = uc) =~ tr/-/_/; $u } ($f, $p);
  ($FS, $PS) = map { (my $u = uc) =~ tr/-/_/; $u } ($fs, $ps);
}
# The suffix in the case the match is written in.
sub cased { my ($m, $s) = @_; $m eq lc $m ? $s : $m eq uc $m ? uc $s : join '-', map { ucfirst } split /-/, $s, -1 }
s{(?<![\w-])(?<!mrogan/)(?<!mrogan\\/)(\Q$f\E)(?![\w-])(?!\\*/mirror)}{$1 . cased($1, $fs)}gie;
s{(?<![\w-])(?<!mrogan/)(?<!mrogan\\/)(\Q$p\E)(?![\w-])}{$1 . cased($1, $ps)}gie;
s{(?<![A-Z0-9])\Q$F\E(?![A-Z0-9_])}{$F$FS}g;
s{(?<![A-Z0-9])\Q$P\E(?![A-Z0-9_])}{$P$PS}g;
