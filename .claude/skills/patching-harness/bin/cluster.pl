#!/usr/bin/perl -pi
# The scratch cluster's names, wherever a copy's code names the real cluster's, so that nothing the copies run on the Mac
# can reach the real one: the k3d cluster and its kube context, the state volume, the cluster lock, the ports the Mac
# publishes, the Keychain entries it reads (the App key, Pushover), and the factory's GitHub App, which is the scratch
# App (app.env). Given SLUG, APP_ID, CLIENT_ID and BOT_ID, the scratch App's.
#
# Left as they are: the local certificate authority (~/.config/software-factory/local-ca), the Mac's, which signs for
# localhost names alone and is already trusted; and the ports inside the cluster (each pod's 8080).
BEGIN {
  ($slug, $app, $client, $bot) = @ENV{qw(SLUG APP_ID CLIENT_ID BOT_ID)};
  $slug && $app && $client && $bot or die "SLUG, APP_ID, CLIENT_ID and BOT_ID: the scratch App's (app.env)";
}
# The cluster, its context and everything k3d names after it (k3d-<name>-serverlb, k3d-<name>-state).
s{\bk3d-software-factory(?![\w])(?!-scratch)}{k3d-software-factory-scratch}g;
s{^(CLUSTER := )software-factory$}{${1}software-factory-scratch};
s{^(  name: )software-factory$}{${1}software-factory-scratch} if $ARGV =~ m{deploy/k3d/cluster\.yaml$};
# The one lock a session holds the cluster by.
s{(\.config', 'software-factory)(', 'cluster\.lock')}{$1-scratch$2}g;
s{(\.config/software-factory)(/cluster\.lock)}{$1-scratch$2}g;
# The ports the Mac publishes: the Kubernetes API, plain HTTP and the console's HTTPS.
s{\blocalhost:8080\b}{localhost:9080}g;
s{\blocalhost:8443\b}{localhost:9443}g;
s{\b127\.0\.0\.1:8080:80\b}{127.0.0.1:9080:80}g;
s{\b127\.0\.0\.1:8443(:443)?\b}{127.0.0.1:9443$1}g;
s{\b6550\b}{6551}g if $ARGV =~ m{(cluster\.yaml|local-cluster\.test\.ts)$};
if ($ARGV =~ m{LOCAL-CLUSTER\.md$}) { s{\b6550\b}{6551}g; s{:8080\b}{:9080}g; s{:8443\b}{:9443}g }
# The Keychain entries only the scratch cluster reads: its App's key, and no Pushover, so it never reaches the phone.
s{(?<![\w-])factory-github-app-key\b}{scratch-factory-github-app-key}g;
s{(?<![\w-])(pushover-app-token|pushover-user-key)\b}{scratch-$1}g;
# The scratch App, wherever the real factory App is named: slug and bot login, App id, client id, bot user id.
s{(?<![\w-])mrogan-software-factory(?![\w-])}{$slug}g;
s{\bIv23liE1Dj3iYkwWX59z\b}{$client}g;
s{(?<![\d.])5187559(?![\d.])}{$app}g;
s{(?<![\d.])337765427(?![\d.])}{$bot}g;
# The same ids as TypeScript writes them, with numeric separators (APP_USER = 337_765_427).
sub grouped { my $n = reverse shift; $n =~ s/(\d{3})(?=\d)/$1_/g; scalar reverse $n }
s{(?<![\d._])5_187_559(?![\d_])}{grouped($app)}ge;
s{(?<![\d._])337_765_427(?![\d_])}{grouped($bot)}ge;
# Martin's operator commands reach the store through a port-forward on the Mac: ports of the scratch cluster's own, so
# a forward that failed can never leave a command talking to the real cluster's Postgres on the real one's port.
s{\b1543([23])\b}{2543$1}g if $ARGV =~ m{Makefile$};
# No private checkout, ever: no answer key, so the scoreboard is off.
s{^PRIVATE_DIR \?= .*$}{override PRIVATE_DIR := /nonexistent/the-scratch-cluster-has-no-private-checkout} if $ARGV =~ m{Makefile$};
# A memory limit on the node, so the scratch cluster can never take the real one's share of Docker's VM.
s{^options:\n}{options:\n  runtime:\n    serversMemory: 10g\n} if $ARGV =~ m{deploy/k3d/cluster\.yaml$};
