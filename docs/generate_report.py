"""Regenerate: pip install reportlab && python docs/generate_report.py
The application itself is TypeScript; Python is only used to produce this report.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.enums import TA_LEFT
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'REPORT.pdf'
W, H = 595.28, 841.89
INK, GREEN, MUTED, PALE = map(HexColor, ['#233e36', '#315944', '#728173', '#edf2e8'])
c = canvas.Canvas(str(OUT), pagesize=(W, H))
c.setTitle('Slotbook - Architecture, reliability and handoff')
c.setAuthor('Slotbook project - AI-assisted implementation')
body = ParagraphStyle('body', fontName='Helvetica', fontSize=10.5, leading=16.2, textColor=INK, alignment=TA_LEFT)
small = ParagraphStyle('small', parent=body, fontSize=9, leading=13)
y = 0

def page(number, label, title, subtitle):
    global y
    c.setFillColor(HexColor('#fafbf8')); c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(GREEN); c.roundRect(42, H-70, 29, 29, 7, fill=1, stroke=0)
    c.setFillColor(white); c.setFont('Helvetica-BoldOblique', 22); c.drawString(49, H-63, 's')
    c.setFillColor(INK); c.setFont('Helvetica-Bold', 17); c.drawString(81, H-61, 'slotbook.')
    c.setFillColor(MUTED); c.setFont('Helvetica', 8); c.drawRightString(W-42, H-59, 'IMPLEMENTATION REPORT / 06 NOV 2026')
    c.setStrokeColor(HexColor('#dce4d7')); c.line(42, H-90, W-42, H-90)
    c.setFillColor(MUTED); c.setFont('Helvetica-Bold', 8); c.drawString(42, H-120, label.upper())
    c.setFillColor(INK); c.setFont('Helvetica-Bold', 27); c.drawString(42, H-160, title)
    y = H-190
    p(subtitle, small, gap=23)
    c.setFillColor(MUTED); c.setFont('Helvetica', 8)
    c.drawString(42, 30, 'Slotbook | TypeScript + React + Express + Postgres')
    c.drawRightString(W-42, 30, f'{number:02d} / 08')

def p(text, style=body, gap=12):
    global y
    paragraph = Paragraph(text, style)
    _, h = paragraph.wrap(W-84, H)
    paragraph.drawOn(c, 42, y-h); y -= h+gap
    if y < 55: raise RuntimeError('Report content overflow; shorten the current page')

def h(text):
    global y
    c.setFillColor(GREEN); c.setFont('Helvetica-Bold', 12); c.drawString(42, y-13, text); y -= 27

def item(title, text):
    p(f'<b>{escape(title)}</b> - {text}', gap=12)

def done(): c.showPage()

page(1, '01 / Delivery', 'A reliable scheduling core.', 'Hosts publish availability. Guests reserve a slot. Postgres coordinates every capacity decision.')
h('Repository and running the demo')
p('<link href="https://github.com/Avinaash076/booking-system" color="#315944">github.com/Avinaash076/booking-system</link>')
p('Run <b>docker compose up --build</b>, then open <b>http://localhost:3000</b>. Startup migrates and seeds the database. Host login: <b>demo / demo-password-change-me</b>. Change the initial password before deploying publicly.')
p('Public pages: <b>/demo/discovery</b> (30-minute, one-on-one) and <b>/demo/workshop</b> (60-minute, four seats). Seed hours are Monday-Friday, 09:00-17:00 Asia/Kolkata, with five-minute buffers and four-hour notice.')
h('Delivered scope')
item('Host', 'Authenticated dashboard, home time zone, event creation, multiple weekly windows, date overrides, upcoming bookings and cancellation reasons.')
item('Guest', 'Thirty-day slot view, time-zone switcher, five-minute holds, confirmation, private manage link, atomic rescheduling and cancellation.')
item('Reliability', 'Real Postgres transactions, host row locking, idempotent holds, database-clock expiry, group capacity, buffer conflicts and a transactional notification sink.')
h('Verification and deployment status')
p('<b>14/14 tests passed</b> on Node 22.20.0 and isolated Postgres 17. Production build and Compose configuration validation passed. The Docker engine was unavailable, so the full container stack was not run. Browser verification was blocked by the automation environment. <b>No public live URL has been deployed.</b>')
done()

page(2, '02 / Architecture', 'One path to a booking.', 'A same-origin React client uses an Express JSON API. Postgres owns durable state and coordination.')
boxes = [('React UI', 'Guest / host / manage'), ('Express API', 'Validate + authenticate'), ('Transaction', 'Lock host + check clock'), ('Postgres', 'Bookings + event sink')]
boxw = (W-84-30)/2
top = y
for i, (title, detail) in enumerate(boxes):
    x = 42+(i%2)*(boxw+30); yy = top-(i//2)*86
    c.setFillColor(PALE); c.roundRect(x, yy-63, boxw, 63, 9, fill=1, stroke=0)
    c.setFillColor(INK); c.setFont('Helvetica-Bold', 12); c.drawString(x+15, yy-25, title)
    c.setFont('Helvetica', 9); c.drawString(x+15, yy-43, detail)
c.setFillColor(GREEN); c.setFont('Helvetica-Bold', 15); c.drawCentredString(W/2, top-36, '>'); c.drawCentredString(W/2, top-122, '>')
y = top-180
h('Hold request flow')
item('1. Validate', 'Require an offset-bearing ISO instant and Idempotency-Key. Resolve the requested host and event. Never trust client-side availability.')
item('2. Coordinate', 'Begin a database transaction. Acquire an advisory transaction lock for the idempotency key, then SELECT the host row FOR UPDATE. All booking and schedule mutations use this host lock.')
item('3. Decide', 'Read clock_timestamp() after the lock. Expire old holds, load schedule and active occupancy, check notice/horizon, grid alignment, buffers and capacity.')
item('4. Commit', 'Insert hold plus idempotency record atomically. On confirmation, update the booking and insert its notification event in one transaction. Return the private manage token only after confirmation.')
h('Failure boundaries')
p('A failed transaction rolls back every write. A lost hold response is retried with the same key. A crashed process releases its database locks. Different app instances still coordinate through the same database; no in-memory lock or Redis is involved.')
done()

page(3, '03 / Data model', 'Small tables. Clear rules.', 'Instants are timestamptz. Availability uses local wall-clock minutes plus an IANA zone.')
item('hosts', 'UUID primary key, unique handle, display name, IANA time zone, salted scrypt password hash. Its row is the lock target for every scheduling mutation.')
item('events', 'Host foreign key and unique (host_id, slug). Duration 15-120 minutes; capacity 1-100; buffers 0-30; notice 0-43200 minutes; horizon 1-365 days. Database CHECK constraints reinforce input validation.')
item('weekly_windows / date_overrides', 'Weekly windows use ISO weekday 1-7 and start/end minutes. A per-host/date override replaces all normal hours; an empty JSON array is a day off. The API rejects overlapping windows.')
item('bookings', 'UUID, host/event, status, start/end, buffered busy bounds, expiry, guest details, private manage token and cancellation reason. A composite foreign key ensures the event belongs to the stored host. CHECK constraints enforce interval order and guest details for confirmed bookings.')
item('idempotency_keys', 'Globally unique key, normalized-request SHA-256 fingerprint and booking foreign key. A replay returns its original booking; mismatched request data is rejected. Keys have no automatic retention pruning in this core.')
item('notifications', 'Append-only confirmation, reschedule and cancellation events with booking ID, payload and creation time. This table is the required local sink; it is not a delivery queue with an email provider.')
item('sessions / schema_migrations', 'SHA-256 session token hashes, host and database expiry; applied migration filenames. Startup migration/seed operations use a database advisory lock.')
h('Where the invariant lives')
p('Primary keys, foreign keys, checks and unique constraints prevent malformed rows. Overlap and group capacity are enforced by the transaction protocol using the locked host row and fresh occupancy reads. Arbitrary SQL writers can bypass that protocol; the database role must remain private to the application.')
done()

page(4, '04 / Decisions', 'Seven deliberate choices.', 'The priority is a core whose failure behavior is understandable and testable.')
item('1. Host-level row lock', 'Chosen over event-level locks because different event types share the host. Chosen over per-slot exclusion constraints because group capacity permits some overlaps. Tradeoff: one busy host serializes requests, including slot-list reads.')
item('2. Post-lock database time', 'Chosen over browser time, process time or transaction-start NOW(). Waiting for a lock can outlive a hold. Expiry decisions use clock_timestamp() after coordination.')
item('3. Live expiry predicate', 'Chosen over relying on a worker to mark holds expired. Capacity excludes every expired timestamp immediately, even when the stored lifecycle status has not yet been materialized.')
item('4. Request fingerprints', 'Chosen over client retries that create new reservations. Same key plus same normalized payload returns the original hold; different payload is a 409. Deliberate new intent must use a fresh key.')
item('5. Single atomic reschedule', 'Chosen over cancel-then-create, which could lose the original booking. Validate the destination excluding the booking itself; update its bounds in the same locked transaction. Destination conflicts roll back.')
item('6. Real instants for time zones', 'Chosen over adding a fixed offset to weekly hours. Minute-by-minute local membership across real UTC instants correctly handles missing and repeated clock times. Tradeoff: more CPU and longer locks than a tuned interval generator.')
item('7. Transactional sink + seeded auth', 'Chosen over external email and magic-link infrastructure for the core. Notifications survive process failures with the booking, and seeded cookie sessions keep the host flow self-contained. Production identity and delivery remain follow-up work.')
done()

page(5, '05 / Reliability', 'The cases that break calendars.', 'Every capacity-changing API call uses the same ordering and transaction boundary.')
item('A burst of contenders', '40 simultaneous holds produce exactly one winner for capacity one, and exactly three for capacity three. Integration test: "40 simultaneous holds". Other events at the same time cannot overlap the host.')
item('Retries and uncertain responses', '15 same-key hold requests resolve to one hold ID. Changed payload returns 409. Eight confirmation retries emit one event; five cancellation retries emit one cancellation event. Integration tests cover each result and notification row count.')
item('The clock passes during a lock wait', 'An integration test holds the host lock while a confirmation waits and the hold expires. Confirmation returns 410 after the lock releases. Expired holds free capacity with no worker.')
item('Buffers and group alignment', 'Busy intervals include before/after buffers. An adjacent event conflicts until those intervals stop overlapping. Only the same event with identical start and end can share group capacity. Tests cover cross-event and adjacent-buffer contention.')
item('A failed or contested move', 'An occupied destination returns 409 and preserves the original instant. Two bookings racing to a new destination produce one success and one conflict. Successful moves release the old interval.')
item('Forged input and host changes', 'Invalid instants/zones are rejected; host APIs require a session; hostile browser origins are blocked. Tests exercise login, event creation, weekly hours, day-off overrides, custom override hours, settings, host cancellation and logout.')
h('Residual risks')
p('The public hold path has no distributed rate limit or bot defense. The login throttle is per process. There is no load benchmark, delivery worker, retention policy or production recovery flow. Structured logs avoid tokens and guest payloads, but broader operational controls remain deployment work.')
done()

page(6, '06 / Time zones', 'Clock time is not elapsed time.', 'A host schedule is local. A reservation is a pair of UTC instants.')
h('Generation and display')
p('For each host-local date, date overrides replace weekly windows. The generator walks actual UTC minutes between that local midnight and the next, tests each minute against local windows, and merges continuous open intervals. Candidate starts align to a local 15-minute grid. Real duration and both buffers must fit inside an open interval; notice and horizon further filter candidates.')
p('The browser starts with its own IANA zone and offers a switcher. It formats the same returned UTC instants in the selected zone. Labels include the offset/zone abbreviation so a repeated time can be distinguished. The API validates tz; the response remains UTC to preserve unambiguous identity.')
h('Spring forward: New York, March 14, 2027')
item('Before transition', '01:45 EST = 06:45 UTC. The local clock jumps from 01:59 to 03:00.')
item('Thirty real minutes later', 'The booking ends at 07:15 UTC = 03:15 EDT. No 02:xx start is generated. The test asserts this exact start/end pair and a 30-minute elapsed duration.')
h('Fall back: New York, November 7, 2027')
p('01:30 occurs twice: <b>05:30 UTC (EDT)</b> and <b>06:30 UTC (EST)</b>. Both may be offered when the host is open. They are separate instants, not duplicate reservations. Unit tests require both UTC values to exist.')
h('Explicit scheduling policies')
p('Availability applies to the entire buffered busy interval. Group sharing requires identical session start/end. Windows do not span midnight; split an overnight pattern into two dates. Host edits affect future selection but keep previously held/confirmed instants intact. The horizon uses elapsed 24-hour days from the database clock. Quarter-hour offset zones are covered by the Kathmandu test.')
done()

page(7, '07 / Testing and AI', 'Evidence, with its limits.', 'Local results recorded November 6, 2026. No unrun checks are presented as passing.')
h('Results and reproduction')
p('<b>14 tests passed, 0 failed, 0 skipped.</b> Five unit tests cover DST gaps/folds, quarter-hour zones, notice/horizon/buffers, day-off overrides and group/conflict rules. Nine integration tests exercise the HTTP API against actual Postgres, including concurrency and host mutations.')
p('Run <b>docker compose --profile test run --build --rm tests</b> for the complete disposable-database suite. Or set <b>TEST_DATABASE_URL</b> to a dedicated database and run <b>npm test</b>. The suite fails explicitly if that variable is absent. Use <b>npm run test:unit</b> for pure tests and <b>npm run build</b> for TypeScript and production compilation.')
p('Local verification used Node 22.20.0 and Postgres 17 on an isolated localhost port. Build passed; Compose configuration parsed successfully. GitHub Actions is configured for Node 22/Postgres 16 on pushes and pull requests; its remote result must be checked after pushing. Docker runtime and browser end-to-end checks were not run successfully.')
h('AI-assisted workflow')
p('OpenAI Codex extracted the supplied brief, inspected the empty repository, designed the lock protocol, and wrote the application, tests and documentation. The user supplied the task and destination. No user-authored manual code edits were observed. AI_LOG.md contains the working priorities, corrections and verification record.')
p('Corrections included an unavailable PDF library (replaced with Poppler extraction), Windows TLS backend failure (OpenSSL with verification enabled), sandbox write restrictions, and an unavailable Docker engine (replaced for local testing with isolated Postgres). Code inspection prompted additional host settings and stale-clock/lock-wait tests. Browser automation was blocked and is listed as a gap.')
h('References used')
p('<link href="https://www.postgresql.org/docs/17/explicit-locking.html" color="#315944">PostgreSQL 17: Explicit Locking</link><br/><link href="https://moment.github.io/luxon/api-docs/index.html" color="#315944">Luxon API documentation</link>',small)
done()

page(8, '08 / Handoff', 'What to do next.', 'Review the core, run the demo, then choose how far to take deployment and optional work.')
h('Optional work included')
p('A GitHub Actions build/test workflow, structured logs with request IDs, a database-backed health endpoint, and a notification sink viewer. Native labels, buttons and forms support keyboard interaction, but no complete accessibility audit is claimed. Observability is partial: no notification-lag or booking metrics dashboard is included.')
h('Known gaps')
p('No live deployment, real email, calendar sync or invites, reminders, webhooks, waitlist, round-robin routing, load test, browser E2E suite, distributed hold-abuse protection or production account recovery. Event types can be created but not edited/deleted in this core. The host UI time control supports up to 23:59; the API supports 1440 as an exclusive end minute.')
h('With another day')
item('First', 'Run guest and host browser flows at desktop/mobile widths, add Playwright coverage, test a full Docker cold start, and check remote CI. Add shared public rate limits and anti-abuse controls before exposing holds.')
item('Then', 'Profile slot generation and lock duration, add metrics and load results, narrow the database role, implement backup/restore and retention, and replace seeded credentials with production account management.')
item('Deploy', 'Use the Dockerfile with managed Postgres 15+, an HTTPS APP_URL, DATABASE_URL, PORT and a strong initial DEMO_PASSWORD. Configure provider TLS and private DB networking. Record the real live URL only after deployment and browser verification.')
h('Submission checklist')
p('Review and personalize this AI-authored report. Keep the unsquashed commit history. Ensure the public GitHub repository contains source, migrations, seed, README, AI_LOG and tests. Add a live URL only if deployed. Submit the repository link and this PDF yourself to the recruiter; no recruiter communication has been sent.')
done()
c.save()
print(OUT)
