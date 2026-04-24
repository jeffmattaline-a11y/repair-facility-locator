/**
 * SRN Google Ratings Sync
 * ─────────────────────────────────────────────────────────────
 * Nightly GitHub Actions script. For each PRF facility:
 *   1. Finds its Google Place ID (via Text Search if not cached)
 *   2. Fetches current rating + review count (Place Details)
 *   3. Patches the Supabase record
 *
 * Env vars required (GitHub Actions secrets):
 *   SUPABASE_URL          – https://amfawopeshfzuxusruyq.supabase.co
 *   SUPABASE_KEY          – service role or anon key with UPDATE policy
 *   GOOGLE_GEOCODING_KEY  – unrestricted server-side key with Places API enabled
 *
 * Schedule: runs via .github/workflows/srn-ratings-sync.yml
 * ─────────────────────────────────────────────────────────────
 */

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_ANON_KEY;
const GOOGLE_KEY          = process.env.GOOGLE_GEOCODING_KEY;

const BATCH_SIZE          = 500;  // Places API calls per run (bumped for bulk initial sync)
const STALE_DAYS          = 7;    // Re-fetch if older than 7 days
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
  // Cast id explicitly as uuid in the filter
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
  // Verify at least one row was actually updated
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
 * Place Details: fetch rating + review count for a known place_id
 * Returns { rating, review_count } or null
 */
async function getPlaceDetails(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${placeId}&fields=rating,user_ratings_total&key=${GOOGLE_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === 'OK' && data.result) {
    return {
      rating:       data.result.rating          ?? null,
      review_count: data.result.user_ratings_total ?? null,
    };
  }
  return null;
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

  // ── Fetch facilities that need a ratings refresh ──────────────
  // Priority 1: PRF facilities with no rating yet
  // Priority 2: PRF facilities with stale ratings (> 7 days old)
  let facilities = [];
  let offset = 0;

  console.log('Fetching facilities needing rating sync...');

  while (true) {
    // Facilities with no google_place_id or stale ratings_updated_at
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

  // ── Process in batches ────────────────────────────────────────
  const toProcess = facilities.slice(0, BATCH_SIZE);
  console.log(`Processing ${toProcess.length} facilities this run (batch limit: ${BATCH_SIZE})...\n`);

  let updated   = 0;
  let noPlaceId = 0;
  let noRating  = 0;
  let errors    = 0;

  for (const facility of toProcess) {
    try {
      let placeId = facility.google_place_id;

      // Step 1: Find Place ID if we don't have one
      if (!placeId) {
        await sleep(DELAY_MS);
        placeId = await findPlaceId(facility);

        if (!placeId) {
          console.log(`  ⚠️  No Place ID found: ${facility.name} (${facility.city}, ${facility.state})`);
          // Still update timestamp so we don't retry every night forever
          // (retry will happen after STALE_DAYS)
          await supabasePatch('facilities', facility.id, {
            ratings_updated_at: new Date().toISOString(),
          });
          noPlaceId++;
          continue;
        }

        console.log(`  🔍 Found Place ID for ${facility.name}: ${placeId}`);
      }

      // Step 2: Get rating + review count
      await sleep(DELAY_MS);
      const details = await getPlaceDetails(placeId);

      if (!details || (details.rating === null && details.review_count === null)) {
        console.log(`  ⚠️  No rating data: ${facility.name}`);
        await supabasePatch('facilities', facility.id, {
          google_place_id:  placeId,
          ratings_updated_at: new Date().toISOString(),
        });
        noRating++;
        continue;
      }

      // Step 3: Patch Supabase
      await supabasePatch('facilities', facility.id, {
        google_place_id:    placeId,
        google_rating:      details.rating,
        google_review_count: details.review_count,
        ratings_updated_at: new Date().toISOString(),
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

  // ── Summary ───────────────────────────────────────────────────
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
