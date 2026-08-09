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

// Caps for the admin composer. news.title and news.content are unbounded
// text in the database, so these are the only limit there is -- without
// them one paste can push every other item off the dashboard.
const NEWS_TITLE_MAX = 120;
const NEWS_CONTENT_MAX = 2000;
const CALENDAR_LIMIT = 500;

// ---------- news ----------

// `limit` is what the caller actually intends to display. The dashboard
// shows five, so it asks for five rather than fetching fifty and
// slicing — the slice was hiding the fetch.
async function fetchNews(limit) {
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : NEWS_LIMIT, NEWS_LIMIT);

  const { data, error } = await supabaseClient
    .from("news")
    .select("id, title, content, image_path, created_at")
    .order("created_at", { ascending: false })
    .limit(cap);

  if (error) throw error;
  return data || [];
}

// Validation lives here, on its own, because the save handler in
// page-dashboard.js has to be able to run it BEFORE it uploads an
// image. It used to exist only inside addNews()/updateNews(), which
// meant the order of operations was: upload the file, then discover the
// headline was blank, then throw -- leaving an object in the bucket
// that no row points at and nothing can find again. One such orphan
// exists in the bucket from the first day of use.
//
// addNews() and updateNews() still call it, so a caller that skips the
// early check is not let through; it is the same implementation either
// way, not a second copy.
function validateNewsFields(title, content) {
  const cleanTitle = String(title == null ? "" : title).trim();
  const cleanContent = String(content == null ? "" : content).trim();

  if (!cleanTitle) throw new Error("A headline is required.");
  if (!cleanContent) throw new Error("Some text is required.");
  if (cleanTitle.length > NEWS_TITLE_MAX) {
    throw new Error(`Headline must be ${NEWS_TITLE_MAX} characters or fewer.`);
  }
  if (cleanContent.length > NEWS_CONTENT_MAX) {
    throw new Error(`Text must be ${NEWS_CONTENT_MAX} characters or fewer.`);
  }
  return { title: cleanTitle, content: cleanContent };
}

// News is written by administrators only. The three functions below all
// go straight at the table rather than through an RPC, because
// news_admin_write already says `is_admin()` for USING and WITH CHECK --
// a wrapper function would be a second copy of that rule to keep in
// step, which is how the two halves of a check drift apart.
//
// A non-admin calling these gets an empty result or a policy error from
// PostgREST, not a silent success. The form in page-dashboard.js is
// hidden for non-admins as well, but that is a courtesy: the row-level
// policy is what actually decides.

// ---------- news images ----------

// The bucket is PRIVATE, so an <img src> pointing straight at it gets a
// 400. Reads go through a short-lived signed URL instead, which is also
// what keeps an image behind the same rule as the news item itself: an
// unapproved user cannot mint one.
const NEWS_IMAGE_BUCKET = "news-images";
const NEWS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const NEWS_SIGNED_URL_TTL = 3600;

// One map, not a list plus a parser. The extension used to be split off
// the uploaded filename, which fails on a file that has no dot in it at
// all: "photo".split(".").pop() is "photo", so the object landed as
// <uuid>.photo. The `|| "bin"` fallback never fired, because pop() on a
// one-element array is not empty.
//
// The type is what the bucket's allowed_mime_types actually checks, so
// deriving the extension from it keeps the name honest and drops the
// dependency on whatever the person happened to call the file.
const NEWS_IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
};
const NEWS_IMAGE_TYPES = Object.keys(NEWS_IMAGE_EXT);

async function uploadNewsImage(file) {
  if (!file) return null;

  // Checked here as well as on the bucket. The bucket is the control --
  // this is so someone picking a 40 MB photo is told immediately rather
  // than after the upload fails.
  if (!NEWS_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Images must be JPEG, PNG, WebP or GIF.");
  }
  if (file.size > NEWS_IMAGE_MAX_BYTES) {
    throw new Error("Images must be 2 MB or smaller.");
  }

  // Random name, not the original. An uploaded filename can carry a
  // person's name, a path, or characters that need escaping every time
  // the value is used; none of that is worth keeping for a dashboard card.
  // The extension comes from the type checked just above, so it always
  // matches the bytes and never depends on the filename.
  const path = `${crypto.randomUUID()}.${NEWS_IMAGE_EXT[file.type]}`;

  const { error } = await supabaseClient
    .storage.from(NEWS_IMAGE_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });

  if (error) throw error;
  return path;
}

async function newsImageUrl(path) {
  if (!path) return null;
  const { data, error } = await supabaseClient
    .storage.from(NEWS_IMAGE_BUCKET)
    .createSignedUrl(path, NEWS_SIGNED_URL_TTL);

  // A missing image should not blank the announcement it belongs to.
  if (error) { console.warn("Couldn't sign news image:", error); return null; }
  return data ? data.signedUrl : null;
}

async function deleteNewsImage(path) {
  if (!path) return;
  const { error } = await supabaseClient
    .storage.from(NEWS_IMAGE_BUCKET)
    .remove([path]);
  // Logged, not thrown: a leftover object is untidy, but failing the
  // whole delete over it would leave the news item on the dashboard.
  if (error) console.warn("Couldn't remove news image:", error);
}

async function addNews(title, content, imagePath) {
  const { title: cleanTitle, content: cleanContent } = validateNewsFields(title, content);

  const { data, error } = await supabaseClient
    .from("news")
    .insert({ title: cleanTitle, content: cleanContent, image_path: imagePath || null })
    .select("id, title, content, image_path, created_at")
    .single();

  if (error) throw error;
  return data;
}

async function updateNews(id, title, content, imagePath) {
  const { title: cleanTitle, content: cleanContent } = validateNewsFields(title, content);

  // created_at is deliberately not touched. An edit is a correction to an
  // existing announcement, not a new one, and rewriting the timestamp
  // would jump it back to the top of a list ordered by it.
  const { data, error } = await supabaseClient
    .from("news")
    .update({ title: cleanTitle, content: cleanContent, image_path: imagePath || null })
    .eq("id", id)
    .select("id, title, content, image_path, created_at")
    .single();

  if (error) throw error;
  return data;
}

async function deleteNews(id, imagePath) {
  const { error } = await supabaseClient
    .from("news")
    .delete()
    .eq("id", id);

  if (error) throw error;

  // Row first, object second. If this order were reversed and the row
  // delete failed, the dashboard would show an announcement whose image
  // no longer exists. An orphaned object is the cheaper of the two.
  await deleteNewsImage(imagePath);
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
    .select("id, event_date, title, image_path");

  if (fromISO) query = query.gte("event_date", fromISO);
  if (toISO) query = query.lte("event_date", toISO);

  const { data, error } = await query
    .order("event_date", { ascending: true })
    .limit(CALENDAR_LIMIT);

  if (error) throw error;
  // dashboard.html expects each event's date on a `date` key.
  return (data || []).map(e => ({ id: e.id, date: e.event_date, title: e.title, image_path: e.image_path }));
}

async function addCalendarEvent(dateStr, title, imagePath) {
  const { data, error } = await supabaseClient
    .from("calendar_events")
    .insert({ event_date: dateStr, title, image_path: imagePath || null })
    .select("id, event_date, title, image_path")
    .single();

  if (error) throw error;
  return { id: data.id, date: data.event_date, title: data.title, image_path: data.image_path };
}

async function deleteCalendarEvent(id, imagePath) {
  const { error } = await supabaseClient
    .from("calendar_events")
    .delete()
    .eq("id", id);

  if (error) throw error;

  // Row first, object second -- same order as deleteNews(), and for the
  // same reason: an orphaned object is cheaper than an event pointing at
  // an image that no longer exists.
  await deleteNewsImage(imagePath);
}
