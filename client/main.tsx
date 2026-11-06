import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DateTime } from "luxon";
import "./style.css";
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "Request failed");
  return d;
}
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = (t: string, z: string) =>
  DateTime.fromISO(t).setZone(z).toFormat("ccc, d LLL yyyy · h:mm a ZZZZ");
function Zone({
  value,
  change,
}: {
  value: string;
  change: (s: string) => void;
}) {
  return (
    <label>
      Time zone
      <select value={value} onChange={(e) => change(e.target.value)}>
        {[
          ...new Set([
            value,
            localZone,
            "UTC",
            ...Intl.supportedValuesOf("timeZone"),
          ]),
        ].map((z) => (
          <option key={z}>{z}</option>
        ))}
      </select>
    </label>
  );
}
function App() {
  const p = location.pathname.split("/").filter(Boolean);
  return (
    <>
      <header>
        <a href="/" className="brand">
          <span className="logo">s</span>slotbook<span className="dot">.</span>
        </a>
        <nav>
          <a href="/demo/discovery">Book a time</a>
          <a href="/host" className="nav-button">
            Host dashboard ↗
          </a>
        </nav>
      </header>
      <main>
        {p[0] === "host" ? (
          <Dashboard />
        ) : p[0] === "manage" && p[1] ? (
          <Manage token={p[1]} />
        ) : (
          <Booking host={p[0] ?? "demo"} slug={p[1] ?? "discovery"} />
        )}
      </main>
      <footer>
        <span>Good conversations start with a little time.</span>
        <span>Slotbook · Made for meeting</span>
      </footer>
    </>
  );
}
function Booking({
  host,
  slug,
  token,
  onMoved,
}: {
  host: string;
  slug: string;
  token?: string;
  onMoved?: () => void;
}) {
  const [zone, setZone] = useState(localZone),
    [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [day, setDay] = useState(""),
    [hold, setHold] = useState<any>(),
    [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const from = new Date(),
        to = new Date(+from + 30 * 86400000);
      setData(
        await api(
          `/hosts/${encodeURIComponent(host)}/events/${encodeURIComponent(slug)}/slots?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), tz: zone })}`,
        ),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [host, slug, zone]);
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);
  const groups: Record<string, any[]> = {};
  for (const s of data?.slots ?? []) {
    const d = DateTime.fromISO(s.start).setZone(zone).toISODate()!;
    (groups[d] ??= []).push(s);
  }
  const chosen = groups[day] ? day : Object.keys(groups)[0];
  async function select(s: any) {
    setBusy(true);
    setError("");
    try {
      if (token) {
        await api(`/bookings/${token}/reschedule`, "POST", { start: s.start });
        onMoved?.();
        return;
      }
      const sk = `slotbook:${host}:${slug}:${s.start}`;
      let key = sessionStorage.getItem(sk);
      if (!key) {
        key = crypto.randomUUID();
        sessionStorage.setItem(sk, key);
      }
      const h = await api(
        "/holds",
        "POST",
        { host, slug, start: s.start },
        { "Idempotency-Key": key },
      );
      if (h.status !== "held" || Date.parse(h.expiresAt) <= Date.now()) {
        sessionStorage.removeItem(sk);
        throw new Error(
          "That previous hold ended. Select the time again to start a fresh hold.",
        );
      }
      setHold(h);
      setNow(Date.now());
    } catch (e: any) {
      setError(e.message);
      void load();
    } finally {
      setBusy(false);
    }
  }
  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const r = await api(`/holds/${hold.id}/confirm`, "POST", {
        name: f.get("name"),
        email: f.get("email"),
      });
      location.assign(`/manage/${r.token}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const seconds = hold
    ? Math.max(0, Math.ceil((Date.parse(hold.expiresAt) - now) / 1000))
    : 0;
  return (
    <>
      <div className="eyebrow">
        {token ? "MAKE A LITTLE CHANGE" : "A LITTLE TIME, WELL SPENT"}
      </div>
      <div className="heading">
        <h1>{token ? "Find your new time." : "Let’s find a time."}</h1>
        <p>A clear calendar. A good conversation. One less back-and-forth.</p>
      </div>
      <div className="booking-layout">
        <aside className="intro">
          <div className="avatar">
            {data?.event.host_name
              ?.split(" ")
              .map((n: string) => n[0])
              .join("") ?? "AM"}
          </div>
          <p className="muted small">You’re meeting with</p>
          <h2>{data?.event.host_name ?? host}</h2>
          <hr />
          <span className="pill">
            {data?.event.capacity > 1 ? "GROUP SESSION" : "ONE-ON-ONE"}
          </span>
          <h3>{data?.event.name ?? "Loading event…"}</h3>
          <p>◷ {data?.event.duration ?? "—"} minutes</p>
          <p>
            ◎{" "}
            {data?.event.capacity > 1
              ? `Up to ${data.event.capacity} guests`
              : "Just you and your host"}
          </p>
          <p className="small muted note">
            Choose a time that works for you. We’ll hold it for five minutes
            while you add your details.
          </p>
          <div className="availability-note">
            ● Times shown in your time zone
          </div>
          {!token && (
            <a
              className="text-link"
              href={
                slug === "discovery"
                  ? `/${host}/workshop`
                  : `/${host}/discovery`
              }
            >
              View {slug === "discovery" ? "group workshop" : "discovery call"}{" "}
              ↗
            </a>
          )}
        </aside>
        <section className="booking-card" aria-busy={loading}>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {hold ? (
            <>
              <div className="step">02 / YOUR DETAILS</div>
              <h2>Your time is on hold.</h2>
              <p>{fmt(hold.start, zone)}</p>
              <p className={seconds ? "timer" : "error"} role="status">
                {seconds
                  ? `Reserved for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                  : "Your hold expired. Please choose a time again."}
              </p>
              <form onSubmit={confirm}>
                <label>
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={120}
                  />
                </label>
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </label>
                <button disabled={busy || !seconds}>
                  {busy ? "Confirming…" : "Confirm booking →"}
                </button>
              </form>
              <button
                className="secondary"
                onClick={() => {
                  setHold(undefined);
                  void load();
                }}
              >
                Back to available times
              </button>
            </>
          ) : (
            <>
              <div className="card-top">
                <div>
                  <div className="step">01 / PICK YOUR MOMENT</div>
                  <h2>Choose a day & time</h2>
                </div>
                <span className="tag">Next 30 days</span>
              </div>
              <Zone value={zone} change={setZone} />
              {loading ? (
                <p className="empty" role="status">
                  Finding available times…
                </p>
              ) : !Object.keys(groups).length ? (
                <div className="empty">
                  <h3>No times available</h3>
                  <p>Check back soon or try another event.</p>
                  <button className="secondary" onClick={() => void load()}>
                    Refresh availability
                  </button>
                </div>
              ) : (
                <>
                  <div className="dates" aria-label="Available days">
                    {Object.keys(groups).map((d) => (
                      <button
                        key={d}
                        className={"date " + (chosen === d ? "selected" : "")}
                        aria-pressed={chosen === d}
                        onClick={() => setDay(d)}
                      >
                        <span>{DateTime.fromISO(d).toFormat("ccc")}</span>
                        <strong>{DateTime.fromISO(d).toFormat("dd")}</strong>
                        <span>{DateTime.fromISO(d).toFormat("LLL")}</span>
                      </button>
                    ))}
                  </div>
                  <div className="time-heading">
                    <h3>{DateTime.fromISO(chosen).toFormat("cccc, LLLL d")}</h3>
                    <small>{groups[chosen].length} times available</small>
                  </div>
                  <div className="times">
                    {groups[chosen].map((s) => (
                      <button
                        className="time"
                        key={s.start}
                        disabled={busy}
                        onClick={() => void select(s)}
                      >
                        {DateTime.fromISO(s.start)
                          .setZone(zone)
                          .toFormat("h:mm a ZZZZ")}
                        {data.event.capacity > 1 && (
                          <small>{s.remaining} seats left</small>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="small muted">
                    {token
                      ? "Your current booking stays in place until the new time is secured."
                      : "Select a time to reserve your spot for 5 minutes."}
                  </p>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
function Manage({ token }: { token: string }) {
  const [b, setB] = useState<any>(),
    [error, setError] = useState(""),
    [moving, setMoving] = useState(false),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState("");
  async function load() {
    try {
      setB(await api(`/bookings/${token}`));
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, [token]);
  if (moving && b)
    return (
      <Booking
        host={b.handle}
        slug={b.slug}
        token={token}
        onMoved={() => {
          setMoving(false);
          void load();
        }}
      />
    );
  return (
    <section className="manage-card">
      <div className="eyebrow">YOUR PRIVATE BOOKING</div>
      <h1>
        {b?.status === "cancelled"
          ? "Booking cancelled."
          : "You’re on the calendar."}
      </h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {b && (
        <>
          <span className="pill">{b.status}</span>
          <h2>{b.name}</h2>
          <p>{fmt(b.start_at, localZone)}</p>
          <p>
            {b.guest_name} · {b.guest_email}
          </p>
          <p className="small muted">
            Save this private URL to manage your booking. Notification events
            are saved locally; email delivery is not configured.
          </p>
          {b.status === "confirmed" ? (
            <>
              <button onClick={() => setMoving(true)}>Reschedule →</button>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    await api(`/bookings/${token}/cancel`, "POST", { reason });
                    await load();
                  } catch (err: any) {
                    setError(err.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Cancellation reason
                  <input
                    required
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button className="danger" disabled={busy}>
                  Cancel booking
                </button>
              </form>
            </>
          ) : (
            <p>Reason: {b.cancel_reason}</p>
          )}
        </>
      )}
    </section>
  );
}
type W = { start: number; end: number };
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function Windows({ value, change }: { value: W[]; change: (w: W[]) => void }) {
  return (
    <div className="window-editor">
      {value.map((w, i) => (
        <div className="window" key={i}>
          <input
            aria-label="Window start"
            type="time"
            required
            value={time(w.start)}
            onChange={(e) =>
              change(
                value.map((v, j) =>
                  j === i ? { ...v, start: minutes(e.target.value) } : v,
                ),
              )
            }
          />
          <span>to</span>
          <input
            aria-label="Window end"
            type="time"
            required
            value={time(Math.min(w.end, 1439))}
            onChange={(e) =>
              change(
                value.map((v, j) =>
                  j === i ? { ...v, end: minutes(e.target.value) } : v,
                ),
              )
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Remove window"
            onClick={() => change(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="link-button"
        onClick={() => change([...value, { start: 540, end: 1020 }])}
      >
        + Add window
      </button>
      {!value.length && <span className="small muted">Unavailable</span>}
    </div>
  );
}
function Dashboard() {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [auth, setAuth] = useState(false),
    [zone, setZone] = useState(localZone),
    [weekly, setWeekly] = useState<Record<number, W[]>>({}),
    [day, setDay] = useState(DateTime.local().toISODate()!),
    [override, setOverride] = useState<W[]>([]),
    [busy, setBusy] = useState(false),
    [reasons, setReasons] = useState<Record<string, string>>({});
  async function load() {
    try {
      const d = await api("/host");
      setData(d);
      setZone(d.host.timezone);
      setWeekly(d.schedule.weekly);
      setAuth(true);
    } catch (e: any) {
      setAuth(false);
      if (e.message !== "Please sign in") setError(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
      setMessage(msg);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!auth)
    return (
      <section className="login-card">
        <div className="eyebrow">YOUR HOST SPACE</div>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in to make room for good conversations.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(
              () =>
                api("/login", "POST", {
                  handle: f.get("handle"),
                  password: f.get("password"),
                }),
              "Signed in",
            );
          }}
        >
          <label>
            Host handle
            <input
              name="handle"
              defaultValue="demo"
              required
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
            />
          </label>
          <button disabled={busy}>Sign in →</button>
        </form>
        <p className="small muted">
          Local demo: demo / demo-password-change-me
        </p>
      </section>
    );
  return (
    <>
      <div className="eyebrow">YOUR HOST SPACE</div>
      <div className="dashboard-title">
        <div>
          <h1>Hello, {data.host.name.split(" ")[0]}.</h1>
          <p className="muted">Your time, thoughtfully organized.</p>
        </div>
        <button
          className="secondary"
          onClick={() => void act(() => api("/logout", "POST"), "Signed out")}
        >
          Sign out
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <div className="dashboard-grid">
        <section className="panel">
          <h2>Home time zone</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () => api("/host/settings", "PUT", { timezone: zone }),
                "Time zone saved",
              );
            }}
          >
            <Zone value={zone} change={setZone} />
            <button disabled={busy}>Save time zone</button>
          </form>
          <p className="small muted">
            Availability follows local time. Existing reservations keep their
            original instants.
          </p>
        </section>
        <section className="panel">
          <h2>Event types</h2>
          {data.events.map((e: any) => (
            <a
              className="event-row"
              key={e.id}
              href={`/${data.host.handle}/${e.slug}`}
            >
              <div>
                <strong>{e.name}</strong>
                <small>
                  {e.duration} min · {e.capacity}{" "}
                  {e.capacity === 1 ? "guest" : "guests"}
                </small>
              </div>
              <span>↗</span>
            </a>
          ))}
        </section>
        <section className="panel">
          <h2>Weekly availability</h2>
          <p className="small muted">
            In {data.host.timezone}. Buffers must fit inside these hours.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api("/host/availability", "PUT", {
                    weekly: Array.from({ length: 7 }, (_, i) => ({
                      weekday: i + 1,
                      windows: weekly[i + 1] ?? [],
                    })),
                  }),
                "Weekly hours saved",
              );
            }}
          >
            {[
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
            ].map((d, i) => (
              <div className="day-row" key={d}>
                <strong>{d}</strong>
                <Windows
                  value={weekly[i + 1] ?? []}
                  change={(w) => setWeekly({ ...weekly, [i + 1]: w })}
                />
              </div>
            ))}
            <button disabled={busy}>Save weekly hours</button>
          </form>
        </section>
        <section className="panel">
          <h2>Date overrides</h2>
          <p className="small muted">
            Replace normal hours. No windows means a day off.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api(`/host/overrides/${day}`, "PUT", { windows: override }),
                "Override saved",
              );
            }}
          >
            <label>
              Date
              <input
                type="date"
                required
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </label>
            <Windows value={override} change={setOverride} />
            <button disabled={busy}>Save override</button>
          </form>
          {Object.entries(data.schedule.overrides).map(
            ([d, ws]: [string, any]) => (
              <div className="override-row" key={d}>
                <span>
                  {d}:{" "}
                  {ws.length
                    ? ws
                        .map((w: W) => `${time(w.start)}–${time(w.end)}`)
                        .join(", ")
                    : "Day off"}
                </span>
                <button
                  className="link-button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/host/overrides/${d}`, "DELETE"),
                      "Override removed",
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ),
          )}
        </section>
        <section className="panel full">
          <h2>Create an event type</h2>
          <form
            className="event-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const body: Record<string, unknown> = {};
              for (const [k, v] of new FormData(form))
                body[k] = ["name", "slug"].includes(k) ? v : Number(v);
              void act(async () => {
                await api("/host/events", "POST", body);
                form.reset();
              }, "Event created");
            }}
          >
            <label>
              Name
              <input
                name="name"
                required
                maxLength={100}
                placeholder="Coffee & ideas"
              />
            </label>
            <label>
              URL slug
              <input
                name="slug"
                required
                pattern="[a-z0-9-]+"
                placeholder="coffee"
                maxLength={80}
              />
            </label>
            {[
              ["duration", "Duration (min)", 30, 15, 120],
              ["capacity", "Capacity", 1, 1, 100],
              ["buffer_before", "Buffer before (min)", 5, 0, 30],
              ["buffer_after", "Buffer after (min)", 5, 0, 30],
              ["notice_minutes", "Minimum notice (min)", 240, 0, 43200],
              ["horizon_days", "Horizon (days)", 30, 1, 365],
            ].map(([k, l, v, min, max]) => (
              <label key={k}>
                {l}
                <input
                  type="number"
                  name={String(k)}
                  required
                  defaultValue={v}
                  min={min}
                  max={max}
                />
              </label>
            ))}
            <button disabled={busy}>Create event →</button>
          </form>
        </section>
        <section className="panel full">
          <h2>
            Upcoming bookings{" "}
            <span className="count">{data.bookings.length}</span>
          </h2>
          {!data.bookings.length && (
            <p className="muted">Your next conversation will appear here.</p>
          )}
          {data.bookings.map((b: any) => (
            <div className="booking-row" key={b.id}>
              <div>
                <strong>{b.event_name}</strong>
                <p>{fmt(b.start_at, data.host.timezone)}</p>
                <small>
                  {b.guest_name} · {b.guest_email}
                </small>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    () =>
                      api(`/host/bookings/${b.id}/cancel`, "POST", {
                        reason: reasons[b.id],
                      }),
                    "Booking cancelled",
                  );
                }}
              >
                <input
                  aria-label="Cancellation reason"
                  placeholder="Cancellation reason"
                  required
                  maxLength={500}
                  value={reasons[b.id] ?? ""}
                  onChange={(e) =>
                    setReasons({ ...reasons, [b.id]: e.target.value })
                  }
                />
                <button className="danger" disabled={busy}>
                  Cancel
                </button>
              </form>
            </div>
          ))}
        </section>
        <section className="panel full">
          <h2>Notification sink</h2>
          <p className="small muted">
            Events saved in the same transaction as each booking change.
          </p>
          {data.notifications.length ? (
            <div className="notifications">
              {data.notifications.map((n: any) => (
                <div key={n.id}>
                  <span className="pill">{n.kind}</span>
                  <span>{n.payload.email}</span>
                  <small>{fmt(n.created_at, data.host.timezone)}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No notification events yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
