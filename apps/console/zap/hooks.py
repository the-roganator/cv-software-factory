"""
ZAP's baseline scan of the console, as Martin's signed-in browser (`scan.ts` starts it): every request ZAP sends
carries his session's cookie and its token, as his browser's do, and it reads the pages and routes its spider cannot
find in the page's HTML, which the page's script draws or calls. It writes nothing that would change the factory: the
two writes it sends are the first halves of signing in and enrolling, which make a challenge and nothing else.
"""
import json
import os
import subprocess
import sys
import threading

# The status the scan ends with when ZAP stops before it answers; scan.ts reads it.
STOPPED = 4

# Set once ZAP answers zap-baseline.py, after which its stopping is the scan's end, not a failure.
answered = threading.Event()


def start_zap(port, extra_zap_params):
    # Called just before zap-baseline.py starts ZAP. If ZAP stops before it answers, as when it cannot listen on its
    # port, zap-baseline.py would wait ten minutes for it; this stops the scan as soon as ZAP does, with ZAP's log. The
    # next process started is ZAP's, and its handle is kept here, as zap-baseline.py keeps none.
    popen = subprocess.Popen

    def start(*args, **kwargs):
        subprocess.Popen = popen
        zap = popen(*args, **kwargs)
        threading.Thread(target=stop_with_zap, args=(zap,), daemon=True).start()
        return zap

    subprocess.Popen = start


def stop_with_zap(zap):
    zap.wait()
    if answered.is_set():
        return
    try:
        with open('zap.out') as log:
            sys.stderr.write(log.read())
    except OSError:
        pass
    sys.stderr.write('ZAP stopped before it answered: its log, if it wrote one, is above.\n')
    sys.stderr.flush()
    # Not 3, which zap-baseline.py exits with for any failure of its own.
    os._exit(STOPPED)


def zap_started(zap, target):
    answered.set()
    # For scan.ts, which starts ZAP again when it has not answered within its limit (start.ts).
    open('/zap/wrk/answered', 'w').close()
    # Every request ZAP sends, Martin's session with it: through the proxy, the console's server never sees the cookie.
    for header, value in (('Cookie', os.environ['SF_SESSION_COOKIE']), ('X-CSRF-Token', os.environ['SF_CSRF_TOKEN'])):
        zap.replacer.add_rule(description=header, enabled='true', matchtype='REQ_HEADER', matchregex='false',
                              matchstring=header, replacement=value)


def zap_tuned(zap):
    target = os.environ['SF_TARGET'].rstrip('/')
    origin = os.environ['SF_ORIGIN']
    # What the page draws or asks for once its script runs: the doors, the events, and the admin service's reads. The
    # live streams are left out: they never end, so ZAP would wait on them until it timed out.
    for path in ('/?view=sign-in', '/?view=enrol', '/api/events?after=0', '/health', '/version',
                 '/admin/health', '/admin/session', '/admin/no-such-route'):
        zap.core.access_url(url=target + path, followredirects='false')
    # A write's answer is scanned too: the options for signing in, and an enrolment code refused.
    host = target.split('://', 1)[1]
    for path, body in (('/admin/sign-in/options', '{}'), ('/admin/enrol/options', '{"code":"not a code"}')):
        request = (f'POST {target}{path} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\n'
                   f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n{body}')
        zap.core.send_request(request=request, followredirects='false')


def zap_pre_shutdown(zap):
    # What ZAP reached, and how each answered, for scan.ts to check that the scan saw the console and the admin service,
    # signed in: a scan that reached nothing would find nothing, and pass.
    target = os.environ['SF_TARGET'].rstrip('/')
    reached = {}
    for message in zap.core.messages(baseurl=target):
        method, url = message['requestHeader'].split(' ')[0:2]
        status = message['responseHeader'].split(' ')[1] if message['responseHeader'] else '0'
        reached[f'{method} {url[len(target):] or "/"}'] = int(status)
    with open('/zap/wrk/reached.json', 'w') as out:
        json.dump(reached, out, indent=2, sort_keys=True)
