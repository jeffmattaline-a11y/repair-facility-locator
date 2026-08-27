/**
 * SRN Ratings Backfill (ONE-OFF)
 * ─────────────────────────────────────────────────────────────
 * Manually-triggered GitHub Actions script. Unlike srn-ratings-sync.js
 * (which refreshes STALE ratings on a nightly cadence), this script
 * targets PRF facilities that already have a google_place_id but are
 * MISSING a rating entirely (google_rating or google_review_count is null).
 * It ignores ratings_updated_at / staleness — this is a one-time catch-up.
 *
 * Env vars required (same GitHub Actions secrets as srn-ratings-sync.js):
 *   SUPABASE_URL          – https://amfawopeshfzuxusruyq.supabase.co
 *   SUPABASE_ANON_KEY      – anon key with UPDATE policy on facilities
 *   GOOGLE_GEOCODING_KEY  – unrestricted server-side key with Places API enabled
 *
 * Trigger manually from the Actions tab (workflow_dispatch) —
 * see .github/workflows/srn-ratings-backfill.yml
 * ─────────────────────────────────────────────────────────────
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const GOOGLE_KEY    = process.env.GOOGLE_GEOCODING_KEY;

const DELAY_MS = 150; // polite delay between Google API calls

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

async function supabasePatch(id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/facilities?id=eq.${id}`, {
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
  try { rows = JSON.parse(text); } catch (e) {}
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`PATCH matched 0 rows for id=${id} — check RLS policies or id format`);
  }
}

/**
 * Same Places API (New) call as srn-ratings-sync.js — strict field mask,
 * stays in the free Basic Data tier.
 */
async function getPlaceDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;

  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'rating,userRatingCount',
    },
  });

  if (!res.ok) {
    console.warn(`  ⚠️  Places API (New) error for ${placeId}: ${res.status}`);
    return null;
  }

  const data = await res.json();
  return {
    rating: data.rating ?? null,
    review_count: data.userRatingCount ?? null,
  };
}

async function main() {
  console.log('━━━ SRN Ratings Backfill (one-off) ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_KEY) {
    console.error('❌ Missing required env vars. Check SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_GEOCODING_KEY.');
    process.exit(1);
  }

  console.log('Fetching PRF facilities with a place_id but missing rating data...');

  const facilities = await supabaseGet(
    `facilities?select=id,name,city,state,google_place_id,google_rating,google_review_count` +
    `&status=eq.PRF` +
    `&google_place_id=not.is.null` +
    `&or=(google_rating.is.null,google_review_count.is.null)`
  );

  console.log(`Found ${facilities.length} facilities to backfill.\n`);

  if (facilities.length === 0) {
    console.log('✅ Nothing to do.');
    return;
  }

  let updated = 0;
  let noRating = 0;
  let errors = 0;

  for (const facility of facilities) {
    try {
      await sleep(DELAY_MS);
      const details = await getPlaceDetails(facility.google_place_id);

      if (!details || (details.rating === null && details.review_count === null)) {
        console.log(`  ⚠️  No rating data on Google: ${facility.name} (${facility.city}, ${facility.state})`);
        noRating++;
        continue;
      }

      await supabasePatch(facility.id, {
        google_rating: details.rating,
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

  console.log('\n━━━ Backfill Summary ━━━');
  console.log(`  ✅ Updated:         ${updated}`);
  console.log(`  ⚠️  No Rating Data: ${noRating}`);
  console.log(`  ❌ Errors:          ${errors}`);
  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
