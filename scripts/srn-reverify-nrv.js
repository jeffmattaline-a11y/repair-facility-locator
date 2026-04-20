const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_KEY;

function supabaseFetch(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data || '[]')); }
        catch (e) { resolve([]); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function geocode(address, city, state, zip) {
  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(`${address}, ${city}, ${state} ${zip}`);
    const path = `/maps/api/geocode/json?address=${query}&key=${GOOGLE_API_KEY}`;
    const req = https.request({
      hostname: 'maps.googleapis.com',
      path,
      method: 'GET'
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'OK' && json.results.length > 0 ? json.results[0] : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Fetching all NRV facilities...');

  // Fetch all NRV records with notes, paginated
  const PAGE = 1000;
  let allNRV = [];
  let from = 0;
  while (true) {
    const batch = await supabaseFetch(
      `facilities?status=eq.NRV&select=id,name,address,city,state,zip,notes&limit=${PAGE}&offset=${from}`
    );
    allNRV = allNRV.concat(batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }

  // Filter in JS for exact note match
  const TARGET_NOTE = 'Address could not be verified by Google';
  const facilities = allNRV.filter(f => f.notes === TARGET_NOTE);

  console.log(`Total NRV records fetched: ${allNRV.length}`);
  console.log(`Matching target note: ${facilities.length}\n`);

  let promoted = 0;
  let stillFailed = 0;
  let errors = 0;

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    process.stdout.write(`[${i + 1}/${facilities.length}] ${f.name} — `);

    try {
      const result = await geocode(f.address, f.city, f.state, f.zip);

      if (result) {
        const updateResult = await supabaseFetch(
          `facilities?id=eq.${f.id}`,
          'PATCH',
          { status: 'PRF', notes: null }
        );
        // Log the raw response to confirm update succeeded
        console.log(`✓ Verified → PRF (update response: ${JSON.stringify(updateResult).substring(0, 80)})`);
        promoted++;
      } else {
        console.log(`✗ Still unverified — left as NRV`);
        stillFailed++;
      }
    } catch (err) {
      console.log(`! Error: ${err.message}`);
      errors++;
    }

    await sleep(100);
  }

  console.log('\n========== RESULTS ==========');
  console.log(`✓ Promoted to PRF:   ${promoted}`);
  console.log(`✗ Still unverified:  ${stillFailed}`);
  console.log(`! Errors:            ${errors}`);
  console.log(`Total processed:     ${facilities.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
