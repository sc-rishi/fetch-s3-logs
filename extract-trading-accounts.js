#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const X_REQ_UIDS = [
  '50156c3d-b36a-4222-bbda-72263f05526e',
  '6c16d921-be43-4451-a2f1-aef7d73b4972',
  '88b3322d-5fed-423d-9117-43198e36be05',
  '92149e07-4f38-4549-b03e-d9b66c148dcd',
  '8ab9bf74-0a09-4df4-b2ea-96d042fb8887',
  'f3db342e-7823-4c8e-b322-e5dbf410a999',
  'b12dcaf6-34bc-4549-8732-6660e8797e8e',
  '899f3815-35c8-46da-a4f7-3aebb296f650',
  'b608f585-b2b2-43a9-8a77-960cc78fa686',
  'c91ce33d-f594-418e-a6c0-1f29322257e9',
  '0c6b1f79-0b73-4854-85f5-aa39b1e2e5e4',
  '2763ddd7-3806-4025-8af8-051df4ab21ab',
  'de2380f7-2fa4-48c7-b7f2-11d75cb639bd',
  '94d9a4ad-2f75-46b6-a082-453c994595cf',
  'f8ca6606-1f85-42f9-97c4-53fdb9000e49',
  '15a122ff-f0e4-4b02-ae73-b6e872365a9d',
  '73312847-486b-4310-a8fe-36f9a69d342a',
  'e6089448-202f-485b-954e-7cbfe340ccf2',
  '5f7ed63d-1aa0-4051-946e-02ee86d7dee1',
  '87721860-d35d-4763-b64e-22e10d36f004',
  '9a7782f1-d3a9-4e1d-9c1d-3511e2261984',
  '5d3f53f8-346c-4372-b9bc-578cf60fdca9',
  '27eef6ec-ae42-4b1a-af31-e7a77a38ebb5',
  'c8647667-5943-4617-bc91-3eec6482d7f4',
  'a0bc3128-46c0-4754-b5f1-af55c7276958',
  '96a456f0-2f6c-47f7-8a30-15dafd46a17e',
  '88cd6bb4-0b68-4496-bf37-09c7db1e6396',
  '8301ed04-4326-4f6b-967c-6ecddde229d6',
  'cbfba826-1814-4ca3-9d67-934db2ba08de',
  'a006bfa7-ef5e-4056-b0ef-a7c9effd29f2',
  '166e7209-1cdb-4145-9e76-61ddee12f6a0',
  '357d75c4-5e0b-4040-8c26-dabf9340fd29',
  'be9f39aa-6702-4c7a-827b-ddb49f00ee06',
  '077a41f4-4b6b-417d-b46d-d657a7e7cdde',
  '09135fbd-1e15-4adf-97f0-a045c89eee75',
  '21b3ec3a-eaa5-4bbb-8d24-85227c609204',
  '69fb7219-3f02-4527-881f-04810c45517d',
  '71475e35-2050-430c-8fc3-a03c644a8ddf',
  '12252520-6e5c-48b5-8c29-270c01625ab9',
  'ba62f8f1-83ff-40f4-95e2-822fb862ea21',
  'd39456ed-c6b0-4e12-9dde-95878b057e56',
  '815117a7-c0c0-46a2-a55c-3e867b1ee88b',
  '5bdebb91-2866-4c80-81ce-71e492e29519',
  'ede9a150-c81b-4b0b-9caa-e561bc8b144b',
  'e6033505-0686-459f-9757-62ff409bc307',
  '032c216f-3a16-4003-9615-cfe9bd405046',
  '4bebb351-ff43-44a0-ae74-d440a14867eb',
  'f21a98ed-73a4-4043-a14a-55f4685717c9',
  'fac69736-c427-466a-ba54-5fc99355f863',
  '9a6862de-f690-4254-9a8f-1ac9d38b1ac4',
  '4643acf5-47bc-45ce-aa8e-8ab01ed16b07',
  'e3e49c44-7397-4c6c-81b8-5719358b8161',
  '75d17174-73d3-496c-8d7d-99f68b437202',
  'f17ba354-ac0b-4792-89d8-3137a36f515f',
  '07840732-5709-4f8a-bcf5-3ce3ef95cd14',
  '06f795a5-71d3-4aef-9a9b-ca2c2da9340a',
  'ce2e6837-7e2f-435a-98fa-1fbfc459c05d',
];

const LOG_FILE = path.join(__dirname, 'logs', 'all-logs.filtered.log');
const OUTPUT_CSV = path.join(__dirname, 'logs', 'key-trading-account-map.csv');

const UID_SET = new Set(X_REQ_UIDS.map((u) => u.toLowerCase()));

function fetchAllLogs() {
  console.log('Fetching all logs from S3 (no filter, no sort)...\n');
  execSync('node fetch-s3-logs.js --no-filter-text --no-sort', {
    cwd: __dirname,
    stdio: 'inherit',
  });
  console.log('\nFetch complete.');
}

function extractTradingAccountNumber(obj) {
  return obj?.context?.data?.data?.details?.request?.data?.tradingAccountDetails?.tradingAccountNumber ?? null;
}

// Stream through the pretty-printed log file one JSON object at a time.
// Tracks brace depth to detect object boundaries without loading the whole file.
async function streamSearchLogs(filePath) {
  const matchCounts = new Map(X_REQ_UIDS.map((u) => [u, 0]));
  const accountNumbers = new Map(X_REQ_UIDS.map((u) => [u, new Set()]));

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lines = [];
  let depth = 0;

  for await (const line of rl) {
    const trimmed = line.trim();

    for (const ch of trimmed) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }

    lines.push(line);

    if (depth === 0 && lines.length > 1) {
      const raw = lines.join('\n');
      const rawLower = raw.toLowerCase();

      for (const uid of UID_SET) {
        if (rawLower.includes(uid)) {
          // Only parse the object if we have a UUID match to avoid unnecessary work
          let parsed;
          try {
            const jsonStr = raw.trim().replace(/,$/, '');
            parsed = JSON.parse(jsonStr);
          } catch {
            break;
          }
          const account = extractTradingAccountNumber(parsed);
          matchCounts.set(uid, (matchCounts.get(uid) || 0) + 1);
          if (account != null) accountNumbers.get(uid).add(String(account));
        }
      }

      lines = [];
    }
  }

  return X_REQ_UIDS.map((uid) => {
    const uidLower = uid.toLowerCase();
    const count = matchCounts.get(uidLower) ?? 0;
    const accounts = [...(accountNumbers.get(uidLower) ?? [])];
    return {
      xReqUid: uid,
      tradingAccountNumber: count === 0 ? 'NOT_FOUND' : (accounts.length > 0 ? accounts.join('|') : 'FIELD_NOT_FOUND'),
      matchCount: count,
    };
  });
}

function writeCsv(results, filePath) {
  const header = 'xReqUid,tradingAccountNumber,matchCount';
  const rows = results.map((r) => `${r.xReqUid},${r.tradingAccountNumber},${r.matchCount}`);
  fs.writeFileSync(filePath, [header, ...rows].join('\n'));
}

async function main() {
  fetchAllLogs();

  console.log('\nStreaming log file to search for UUIDs...');
  const results = await streamSearchLogs(LOG_FILE);

  writeCsv(results, OUTPUT_CSV);
  console.log(`\nCSV written to: ${OUTPUT_CSV}\n`);
  console.table(results);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
