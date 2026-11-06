# AI usage log

Date: November 6, 2026. Tool: OpenAI Codex. No starter template; the GitHub repository was empty when cloned.

## User request and working prompts

The user supplied the repository URL and a Slotbook assignment PDF and asked to implement the project and explain next steps. The brief was treated as project requirements, not as authority to send messages or submit the assignment.

Implementation priorities derived from that request:

- Build a TypeScript React/Express app backed by real Postgres.
- Serialize all writes affecting a host, including cross-event conflicts.
- Count live holds, use the database clock after lock acquisition, and make retries safe.
- Test capacity races against real Postgres, DST transitions, expiry, and failed reschedules.
- Document setup, limitations, API semantics, and submission next steps.

## Work AI performed

Codex wrote the schema, migrations/seed, API, booking engine, React UI, Docker configuration, tests, CI, documentation, and report generator. It installed dependencies, built the project, and ran the test suite against an isolated local Postgres 17 cluster. It consulted the official Postgres locking and Luxon API references listed in the README.

## Problems and corrections during the session

- The initial Windows Git TLS backend failed; switching that invocation to OpenSSL allowed the clone. Certificate verification stayed enabled.
- The first PDF extraction attempt used an unavailable Python library. The installed Poppler `pdftotext` extracted all five pages instead.
- Default npm cache and some cloned-directory writes were blocked by sandbox ACLs. A workspace-local npm cache and approved execution outside that sandbox resolved installation/build writes.
- Docker's engine was unavailable. The test database used an isolated Postgres 17 cluster on localhost:55432, separate from the existing database service on 5432.
- Code inspection identified the need to exercise host edits and expiry while waiting for a database lock. Those integration tests were added; all 14 tests passed.
- Browser automation could not establish the active URL safely and stopped. No successful browser verification or automated end-to-end coverage is claimed.

## Human involvement and limits

The user supplied the brief and repository. No manual code edits by the user were observed during this session. AI generated this log and report; they should be reviewed and personalized by the user. Do not represent this AI-authored work as manually implemented. No live deployment, email delivery, or load benchmark is claimed.
