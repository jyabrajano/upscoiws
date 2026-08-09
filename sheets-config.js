// ============================================================
// sheets-config.js
//
// Data layer for the dashboard's "News & Updates" and "Calendar"
// cards. Load AFTER config.js (needs supabaseClient) and BEFORE
// approval.js:
//   <script src="config.js"></script>
//   <script src="sheets-config.js"></script>
//   <script src="approval.js"></script>
//
// Backed by two Supabase tables — see deploy-schema.sql
// for the CREATE TABLE + RLS statements. Everyone signed in can
// read; only an administrator (is_admin()) can add or delete a
// calendar event, enforced by RLS the same way the rest of the
// app enforces admin-only writes.
// ============================================================

// ---------- limits ----------
//
// Neither of these queries used to be bounded. Both tables only grow —
// nothing prunes news, and calendar events accumulate a month at a time
// — so every dashboard load was fetching every row ever written and
// throwing almost all of it away client-side. It costs nothing at
// launch and gets slowly worse forever, which is the kind of thing that
// is never diagnosed as a query problem because it was never fast or
// slow, only gradually slower.
//
// The caps below are deliberately generous. They exist so the payload
// has a ceiling at all, not to ration anything.
const NEWS_LIMIT = 50;
const CALENDAR_LIMIT = 500;

// ---------- news ----------

// `limit` is what the caller actually intends to display. The dashboard
// shows five, so it asks for five rather than fetching fifty and
// slicing — the slice was hiding the fetch.
async function fetchNews(limit) {
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : NEWS_LIMIT, NEWS_LIMIT);

  const { data, error } = await supabaseClient
    .from("news")
    .select("id, title, content, created_at")
    .order("created_at", { ascending: false })
    .limit(cap);

  if (error) throw error;
  return data || [];
}

// ---------- calendar ----------

// Fetches one window rather than the whole table. `fromISO` and `toISO`
// are inclusive YYYY-MM-DD bounds; called with neither, it still caps
// at CALENDAR_LIMIT so an unbounded call can't come back.
//
// dashboard.html loads a window around the month on screen and reloads
// when you navigate past its edge, so paging back through a few years
// still works — it just does it a window at a time.
async function fetchCalendarEvents(fromISO, toISO) {
  let query = supabaseClient
    .from("calendar_events")
    .select("id, event_date, title");

  if (fromISO) query = query.gte("event_date", fromISO);
  if (toISO) query = query.lte("event_date", toISO);

  const { data, error } = await query
    .order("event_date", { ascending: true })
    .limit(CALENDAR_LIMIT);

  if (error) throw error;
  // dashboard.html expects each event's date on a `date` key.
  return (data || []).map(e => ({ id: e.id, date: e.event_date, title: e.title }));
}

async function addCalendarEvent(dateStr, title) {
  const { data, error } = await supabaseClient
    .from("calendar_events")
    .insert({ event_date: dateStr, title })
    .select("id, event_date, title")
    .single();

  if (error) throw error;
  return { id: data.id, date: data.event_date, title: data.title };
}

async function deleteCalendarEvent(id) {
  const { error } = await supabaseClient
    .from("calendar_events")
    .delete()
    .eq("id", id);

  if (error) throw error;
}
