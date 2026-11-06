CREATE TABLE hosts (
  id uuid PRIMARY KEY, handle text NOT NULL UNIQUE,
  name text NOT NULL, timezone text NOT NULL,
  password_hash text NOT NULL
);
CREATE TABLE events (
  id uuid PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id),
  name text NOT NULL, slug text NOT NULL,
  duration int NOT NULL CHECK (duration BETWEEN 15 AND 120),
  capacity int NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  buffer_before int NOT NULL CHECK (buffer_before BETWEEN 0 AND 30),
  buffer_after int NOT NULL CHECK (buffer_after BETWEEN 0 AND 30),
  notice_minutes int NOT NULL CHECK (notice_minutes BETWEEN 0 AND 43200),
  horizon_days int NOT NULL CHECK (horizon_days BETWEEN 1 AND 365),
  UNIQUE(host_id,slug), UNIQUE(id,host_id)
);
-- Wall-clock minutes; weekday follows ISO: Monday=1, Sunday=7.
CREATE TABLE weekly_windows (
  id bigserial PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id),
  weekday int NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute int NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute int NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute)
);
-- An empty windows array means a day off; overrides replace that day's weekly windows.
CREATE TABLE date_overrides (
  host_id uuid NOT NULL REFERENCES hosts(id), day date NOT NULL,
  windows jsonb NOT NULL CHECK (jsonb_typeof(windows)='array'),
  PRIMARY KEY(host_id,day)
);
CREATE TABLE bookings (
  id uuid PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id),
  event_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('held','confirmed','cancelled','expired')),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  busy_start timestamptz NOT NULL, busy_end timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  manage_token text NOT NULL UNIQUE, guest_name text, guest_email text, cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(event_id,host_id) REFERENCES events(id,host_id),
  CHECK (start_at < end_at AND busy_start <= start_at AND busy_end >= end_at),
  CHECK (status <> 'confirmed' OR (guest_name IS NOT NULL AND guest_email IS NOT NULL))
);
CREATE INDEX booking_host_busy ON bookings(host_id,busy_start,busy_end) WHERE status IN ('held','confirmed');
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY, fingerprint text NOT NULL, booking_id uuid NOT NULL REFERENCES bookings(id)
);
CREATE TABLE notifications (
  id bigserial PRIMARY KEY, booking_id uuid NOT NULL REFERENCES bookings(id),
  kind text NOT NULL CHECK(kind IN ('confirmed','rescheduled','cancelled')),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id), expires_at timestamptz NOT NULL
);
