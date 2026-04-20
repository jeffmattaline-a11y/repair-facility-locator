const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

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
      res.on('end', () => resolve(JSON.parse(data || '[]')));
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
        const json = JSON.parse(data);
        if (json.status === 'OK' && json.results.length > 0) {
          resolve(json.results[0]);
        } else {
          resolve(null);
        }
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
  console.log('Fetching NRV facilities with unverified address note...');

  // Fetch all matching NRV records
  const facilities = await supabaseFetch(
    `facilities?status=eq.NRV&notes=eq.Address%20could%20not%20be%20verified%20by%20Google&select=id,name,address,city,state,zip`
  );

  console.log(`Found ${facilities.length} records to re-verify.\n`);

  let promoted = 0;
  let stillFailed = 0;
  let errors = 0;

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    process.stdout.write(`[${i + 1}/${facilities.length}] ${f.name} — `);

    try {
      const result = await geocode(f.address, f.city, f.state, f.zip);

      if (result) {
        // Update to PRF and clear note
        await supabaseFetch(
          `facilities?id=eq.${f.id}`,
          'PATCH',
          { status: 'PRF', notes: null }
        );
        console.log(`✓ Verified → PRF`);
        promoted++;
      } else {
        console.log(`✗ Still unverified — left as NRV`);
        stillFailed++;
      }
    } catch (err) {
      console.log(`! Error: ${err.message}`);
      errors++;
    }

    // Throttle to ~10 requests/sec to stay under Google's limit
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
