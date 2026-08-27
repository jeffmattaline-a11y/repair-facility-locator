/**
 * SRN Google Ratings Sync
 * ─────────────────────────────────────────────────────────────
 * Nightly GitHub Actions script. For each PRF facility:
 *   1. Finds its Google Place ID (via Text Search if not cached)
 *   2. Fetches current rating + review count (Places API New)
 *   3. Patches the Supabase record
 *
 * Cost optimizations vs. prior version:
 *   - getPlaceDetails() migrated to Places API (New) with strict
 *     field mask (places.rating, places.userRatingCount only).
 *     This eliminates the "Atmosphere Data" SKU (~$300/mo) and
 *     keeps Place Details in the free Basic Data tier.
 *   - STALE_DAYS increased 5 → 30 (ratings don't change daily)
 *   - BATCH_SIZE reduced 4000 → 500 (safety cap, ~500 calls/night)
 *
 * Bug fix (2026-08-27): getPlaceDetails() previously returned `null`
 * for BOTH an API error (e.g. 403) and a successful call with no
 * rating data. The caller treated both cases identically and stamped
 * ratings_updated_at either way — meaning a failing API call would
 * get marked "checked" and silently skipped for STALE_DAYS. Now
 * getPlaceDetails() returns a `success` flag so failed calls are
 * NOT stamped and will be retried on the next run.
 *
 * Env vars required (GitHub Actions secrets):
 *   SUPABASE_URL          – https://amfawopeshfzuxusruyq.supabase.co
 *   SUPABASE_ANON_KEY     – anon key with UPDATE policy on facilities
 *   GOOGLE_GEOCODING_KEY  – unrestricted server-side key with Places API enabled
 *
 * Schedule: runs via .github/workflows/srn-ratings-sync.yml
 * ─────────────────────────────────────────────────────────────
 */

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_ANON_KEY;
const GOOGLE_KEY          = process.env.GOOGLE_GEOCODING_KEY;

const BATCH_SIZE          = 500;  // ~500 calls/night keeps monthly well under budget
const STALE_DAYS          = 30;   // Re-fetch once per month (ratings are stable)
const DELAY_MS            = 100;  // Polite delay between API calls (ms)

// ─── Helpers ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePatch(table, id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH failed for ${id}: ${res.status} ${text}`);
  let rows = [];
  try { rows = JSON.parse(text); } catch(e) {}
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`PATCH matched 0 rows for id=${id} — check RLS policies or id format`);
  }
}

// ─── Google Places helpers ──────────────────────────────────────

/**
 * Text Search: find a Place ID by facility name + address
 * Returns place_id string or null
 */
async function findPlaceId(facility) {
  const query = encodeURIComponent(
    `${facility.name} ${facility.address || ''} ${facility.city || ''} ${facility.state || ''}`
  );
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
    `?input=${query}&inputtype=textquery&fields=place_id,name&key=${GOOGLE_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === 'OK' && data.candidates && data.candidates.length > 0) {
    return data.candidates[0].place_id;
  }

  // Fallback: Text Search (broader)
  if (data.status !== 'OK') {
    const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${query}&key=${GOOGLE_KEY}`;
    const tsRes = await fetch(tsUrl);
    const tsData = await tsRes.json();
    if (tsData.status === 'OK' && tsData.results && tsData.results.length > 0) {
      return tsData.results[0].place_id;
    }
  }

  return null;
}

/**
 * Place Details (New): fetch rating + review count for a known place_id.
 *
 * Returns { success: true, rating, review_count } if the API call
 * succeeded (rating/review_count may still legitimately be null if
 * Google has no rating for this place).
 *
 * Returns { success: false } if the API call itself failed (network
 * error, 403, 404, etc.) — the caller should NOT treat this the same
 * as "no rating exists" and should NOT stamp ratings_updated_at.
 */
async function getPlaceDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key':   GOOGLE_KEY,
        'X-Goog-FieldMask': 'rating,userRatingCount',
      },
    });
  } catch (err) {
    console.warn(`  ⚠️  Places API (New) network error for ${placeId}: ${err.message}`);
    return { success: false };
  }

  if (!res.ok) {
    console.warn(`  ⚠️  Places API (New) error for ${placeId}: ${res.status}`);
    return { success: false };
  }

  const data = await res.json();

  // Places API (New) returns a top-level object, not data.result
  return {
    success:      true,
    rating:       data.rating          ?? null,
    review_count: data.userRatingCount ?? null,
  };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('━━━ SRN Google Ratings Sync ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_KEY) {
    console.error('❌ Missing required env vars. Check SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_GEOCODING_KEY.');
    process.exit(1);
  }

  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let facilities = [];
  let offset = 0;

  console.log('Fetching facilities needing rating sync...');

  while (true) {
    const batch = await supabaseGet(
      `facilities?select=id,name,address,city,state,zip,phone,google_place_id,ratings_updated_at` +
      `&status=eq.PRF` +
      `&or=(ratings_updated_at.is.null,ratings_updated_at.lt.${staleThreshold})` +
      `&order=ratings_updated_at.asc.nullsfirst` +
      `&limit=1000&offset=${offset}`
    );

    if (!batch || batch.length === 0) break;
    facilities = facilities.concat(batch);
    offset += 1000;
    if (batch.length < 1000) break;
  }

  console.log(`Found ${facilities.length} facilities needing rating sync.\n`);

  if (facilities.length === 0) {
    console.log('✅ All ratings are current. Nothing to do.');
    return;
  }

  const toProcess = facilities.slice(0, BATCH_SIZE);
  console.log(`Processing ${toProcess.length} facilities this run (batch limit: ${BATCH_SIZE})...\n`);

  let updated   = 0;
  let noPlaceId = 0;
  let noRating  = 0;
  let errors    = 0;

  for (const facility of toProcess) {
    try {
      let placeId = facility.google_place_id;

      if (!placeId) {
        await sleep(DELAY_MS);
        placeId = await findPlaceId(facility);

        if (!placeId) {
          console.log(`  ⚠️  No Place ID found: ${facility.name} (${facility.city}, ${facility.state})`);
          await supabasePatch('facilities', facility.id, {
            ratings_updated_at: new Date().toISOString(),
          });
          noPlaceId++;
          continue;
        }

        console.log(`  🔍 Found Place ID for ${facility.name}: ${placeId}`);
      }

      await sleep(DELAY_MS);
      const details = await getPlaceDetails(placeId);

      if (!details.success) {
        // API call itself failed — do NOT stamp ratings_updated_at,
        // so this facility stays "stale" and gets retried next run.
        console.log(`  ❌ API call failed, will retry next run: ${facility.name}`);
        errors++;
        continue;
      }

      if (details.rating === null && details.review_count === null) {
        // Call succeeded, Google genuinely has no rating for this place.
        console.log(`  ⚠️  No rating data: ${facility.name}`);
        await supabasePatch('facilities', facility.id, {
          google_place_id:    placeId,
          ratings_updated_at: new Date().toISOString(),
        });
        noRating++;
        continue;
      }

      await supabasePatch('facilities', facility.id, {
        google_place_id:     placeId,
        google_rating:       details.rating,
        google_review_count: details.review_count,
        ratings_updated_at:  new Date().toISOString(),
      });

      console.log(
        `  ✅ ${facility.name} (${facility.city}, ${facility.state})` +
        ` → ⭐ ${details.rating} (${details.review_count?.toLocaleString()} reviews)`
      );
      updated++;

    } catch (err) {
      console.error(`  ❌ Error processing ${facility.name}: ${err.message}`);
      errors++;
    }
  }

  console.log('\n━━━ Sync Summary ━━━');
  console.log(`  ✅ Updated:         ${updated}`);
  console.log(`  ⚠️  No Place ID:    ${noPlaceId}`);
  console.log(`  ⚠️  No Rating Data: ${noRating}`);
  console.log(`  ❌ Errors:          ${errors}`);
  console.log(`  📋 Remaining:       ${Math.max(0, facilities.length - BATCH_SIZE)}`);
  console.log(`\nCompleted: ${new Date().toISOString()}`);

  if (facilities.length > BATCH_SIZE) {
    console.log(`\nℹ️  ${facilities.length - BATCH_SIZE} facilities remain — will continue in nightly runs.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
