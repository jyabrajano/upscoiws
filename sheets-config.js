const NEWS_LIMIT = 50;

const NEWS_TITLE_MAX = 120;

const NEWS_CONTENT_MAX = 2e3;

const CALENDAR_LIMIT = 500;

async function fetchNews(limit) {
  const cap = Math.min(Number(limit) > 0 ? Number(limit) : NEWS_LIMIT, NEWS_LIMIT);
  const {data: data, error: error} = await supabaseClient.from("news").select("id, title, content, image_path, thumb_data, created_at").order("created_at", {
    ascending: false
  }).limit(cap);
  if (error) throw error;
  return data || [];
}

const NEWS_IMAGE_BUCKET = "news-images";

const NEWS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const NEWS_IMAGE_TYPES = [ "image/jpeg", "image/png", "image/webp", "image/gif" ];

const NEWS_SIGNED_URL_TTL = 3600;

const NEWS_IMAGE_MAX_DIM = 1600;

const NEWS_THUMB_MAX_CHARS = 2e4;

function drawScaled(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image;
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      let out = canvas.toDataURL("image/webp", quality);
      if (!out.startsWith("data:image/webp")) {
        out = canvas.toDataURL("image/jpeg", quality);
      }
      resolve({
        dataUrl: out,
        width: w,
        height: h
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image."));
    };
    img.src = url;
  });
}

async function makeThumbData(file) {
  try {
    const {dataUrl: dataUrl} = await drawScaled(file, 48, .72);
    return dataUrl.length <= NEWS_THUMB_MAX_CHARS ? dataUrl : null;
  } catch (e) {
    console.warn("Couldn't build inline thumbnail:", e);
    return null;
  }
}

async function shrinkForUpload(file) {
  try {
    const {dataUrl: dataUrl} = await drawScaled(file, NEWS_IMAGE_MAX_DIM, .85);
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    if (blob.size >= file.size) return file;
    return new File([ blob ], file.name, {
      type: blob.type
    });
  } catch (e) {
    console.warn("Couldn't downscale image, uploading original:", e);
    return file;
  }
}

async function uploadNewsImage(file) {
  if (!file) return null;
  if (!NEWS_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Images must be JPEG, PNG, WebP or GIF.");
  }
  if (file.size > NEWS_IMAGE_MAX_BYTES) {
    throw new Error("Images must be 2 MB or smaller.");
  }
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${crypto.randomUUID()}.${ext || "bin"}`;
  const toUpload = await shrinkForUpload(file);
  const {error: error} = await supabaseClient.storage.from(NEWS_IMAGE_BUCKET).upload(path, toUpload, {
    cacheControl: "3600",
    upsert: false
  });
  if (error) throw error;
  return path;
}

const signedUrlCache = new Map;

const SIGNED_URL_CACHE_MS = (NEWS_SIGNED_URL_TTL - 60) * 1e3;

function cachedUrl(path) {
  const hit = signedUrlCache.get(path);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    signedUrlCache.delete(path);
    return null;
  }
  return hit.url;
}

function cacheUrl(path, url) {
  if (url) signedUrlCache.set(path, {
    url: url,
    expires: Date.now() + SIGNED_URL_CACHE_MS
  });
}

async function newsImageUrls(paths) {
  const wanted = [ ...new Set((paths || []).filter(Boolean)) ];
  const out = new Map;
  const missing = [];
  for (const p of wanted) {
    const hit = cachedUrl(p);
    if (hit) out.set(p, hit); else missing.push(p);
  }
  if (!missing.length) return out;
  const {data: data, error: error} = await supabaseClient.storage.from(NEWS_IMAGE_BUCKET).createSignedUrls(missing, NEWS_SIGNED_URL_TTL);
  if (error) {
    console.warn("Couldn't sign images:", error);
    return out;
  }
  (data || []).forEach(row => {
    if (row && row.signedUrl && !row.error) {
      out.set(row.path, row.signedUrl);
      cacheUrl(row.path, row.signedUrl);
    }
  });
  return out;
}

async function newsImageUrl(path) {
  if (!path) return null;
  const hit = cachedUrl(path);
  if (hit) return hit;
  const map = await newsImageUrls([ path ]);
  return map.get(path) || null;
}

async function deleteNewsImage(path) {
  if (!path) return;
  signedUrlCache.delete(path);
  const {error: error} = await supabaseClient.storage.from(NEWS_IMAGE_BUCKET).remove([ path ]);
  if (error) console.warn("Couldn't remove news image:", error);
}

async function addNews(title, content, imagePath, thumbData) {
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
  const {data: data, error: error} = await supabaseClient.from("news").insert({
    title: cleanTitle,
    content: cleanContent,
    image_path: imagePath || null,
    thumb_data: thumbData || null
  }).select("id, title, content, image_path, thumb_data, created_at").single();
  if (error) throw error;
  return data;
}

async function updateNews(id, title, content, imagePath, thumbData) {
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
  const {data: data, error: error} = await supabaseClient.from("news").update({
    title: cleanTitle,
    content: cleanContent,
    image_path: imagePath || null,
    thumb_data: thumbData || null
  }).eq("id", id).select("id, title, content, image_path, thumb_data, created_at").single();
  if (error) throw error;
  return data;
}

async function deleteNews(id, imagePath) {
  const {error: error} = await supabaseClient.from("news").delete().eq("id", id);
  if (error) throw error;
  await deleteNewsImage(imagePath);
}

async function fetchCalendarEvents(fromISO, toISO) {
  let query = supabaseClient.from("calendar_events").select("id, event_date, title, image_path, thumb_data");
  if (fromISO) query = query.gte("event_date", fromISO);
  if (toISO) query = query.lte("event_date", toISO);
  const {data: data, error: error} = await query.order("event_date", {
    ascending: true
  }).limit(CALENDAR_LIMIT);
  if (error) throw error;
  return (data || []).map(e => ({
    id: e.id,
    date: e.event_date,
    title: e.title,
    image_path: e.image_path,
    thumb_data: e.thumb_data
  }));
}

async function addCalendarEvent(dateStr, title, imagePath, thumbData) {
  const {data: data, error: error} = await supabaseClient.from("calendar_events").insert({
    event_date: dateStr,
    title: title,
    image_path: imagePath || null,
    thumb_data: thumbData || null
  }).select("id, event_date, title, image_path, thumb_data").single();
  if (error) throw error;
  return {
    id: data.id,
    date: data.event_date,
    title: data.title,
    image_path: data.image_path,
    thumb_data: data.thumb_data
  };
}

async function deleteCalendarEvent(id, imagePath) {
  const {error: error} = await supabaseClient.from("calendar_events").delete().eq("id", id);
  if (error) throw error;
  await deleteNewsImage(imagePath);
}
