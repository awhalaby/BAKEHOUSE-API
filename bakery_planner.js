// Bakery Planner MVP (Node.js, no deps)
// - Loads sample datasets
// - Forecasts demand per 20-min bucket
// - Computes sellable inventory (bake 20 + cool 20 => sellable from t-120..t-40)
// - Plans batches (6 or 12) to cover projected shortfalls just-in-time
// - Assigns to ovens/racks with 20-min slots (drag-drop ready model)

/***********************
 * 1) Sample datasets  *
 ***********************/
const horizonHour = 5;
const horizonMin = horizonHour * 60;

const skuConfig = [
  {
    sku: "WG_CHCR_LQ",
    name: "Chocolate Croissant",
    batch_sizes: [6, 12],
    bake_min: 20,
    cool_min: 20,
    sell_window_min: [40, 120],
    perish_min: 240,
  },
  {
    sku: "WG_MUFF_BLU",
    name: "Blueberry Muffin",
    batch_sizes: [6, 12],
    bake_min: 20,
    cool_min: 20,
    sell_window_min: [40, 120],
    perish_min: 240,
  },
];

const ovenConfig = [
  { oven_id: "oven1", racks: 6 },
  { oven_id: "oven2", racks: 6 },
];

const posData = [
  { date: "2025-10-21 07:01:00", sku: "WG_CHCR_LQ", qty: 1 },
  { date: "2025-10-21 07:20:00", sku: "WG_CHCR_LQ", qty: 5 },
  { date: "2025-10-21 07:40:00", sku: "WG_CHCR_LQ", qty: 7 },
  { date: "2025-10-21 08:00:00", sku: "WG_CHCR_LQ", qty: 10 },
  { date: "2025-10-21 08:20:00", sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-21 08:40:00", sku: "WG_CHCR_LQ", qty: 8 },
  { date: "2025-10-21 09:00:00", sku: "WG_CHCR_LQ", qty: 6 },
  { date: "2025-10-21 09:20:00", sku: "WG_MUFF_BLU", qty: 5 },
  { date: "2025-10-21 09:40:00", sku: "WG_MUFF_BLU", qty: 8 },
  { date: "2025-10-21 10:00:00", sku: "WG_MUFF_BLU", qty: 10 },
  { date: "2025-10-21 10:20:00", sku: "WG_MUFF_BLU", qty: 12 },
  { date: "2025-10-22 07:00:00", sku: "WG_CHCR_LQ", qty: 6 },
  { date: "2025-10-22 07:20:00", sku: "WG_CHCR_LQ", qty: 9 },
  { date: "2025-10-22 07:40:00", sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-22 08:00:00", sku: "WG_CHCR_LQ", qty: 13 },
  { date: "2025-10-22 08:20:00", sku: "WG_CHCR_LQ", qty: 10 },
  { date: "2025-10-22 08:40:00", sku: "WG_MUFF_BLU", qty: 8 },
  { date: "2025-10-22 09:00:00", sku: "WG_MUFF_BLU", qty: 9 },
  { date: "2025-10-22 09:20:00", sku: "WG_MUFF_BLU", qty: 11 },
  { date: "2025-10-22 09:40:00", sku: "WG_MUFF_BLU", qty: 10 },
];

const ovenLogs = [
  { date: "2025-10-21 06:00:00", oven: "oven1", rack: 1, sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-21 06:00:00", oven: "oven1", rack: 2, sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-21 06:20:00", oven: "oven2", rack: 1, sku: "WG_MUFF_BLU", qty: 12 },
  { date: "2025-10-21 06:40:00", oven: "oven2", rack: 2, sku: "WG_MUFF_BLU", qty: 12 },
  { date: "2025-10-22 06:00:00", oven: "oven1", rack: 1, sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-22 06:20:00", oven: "oven1", rack: 2, sku: "WG_CHCR_LQ", qty: 12 },
  { date: "2025-10-22 06:40:00", oven: "oven2", rack: 1, sku: "WG_MUFF_BLU", qty: 12 },
  { date: "2025-10-22 07:00:00", oven: "oven2", rack: 2, sku: "WG_MUFF_BLU", qty: 12 },
];

/*************************
 * 2) Time utils (20-min) *
 *************************/
const MIN = 60 * 1000;
const SLOT_MIN = 20;
const SLOT_MS = SLOT_MIN * MIN;

function parseLocal(ts) {
  // interpret as local time (no timezone suffix)
  return new Date(ts.replace(" ", "T"));
}

function fmt(ts) {
  return new Date(ts).toLocaleString();
}

function floorToSlot(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const minutes = d.getMinutes();
  const bucket = Math.floor(minutes / SLOT_MIN) * SLOT_MIN;
  d.setMinutes(bucket);
  return d;
}

function addMinutes(date, m) {
  return new Date(date.getTime() + m * MIN);
}

function rangeSlots(start, end) {
  const slots = [];
  for (let t = +floorToSlot(start); t < +end; t += SLOT_MS) {
    slots.push(new Date(t));
  }
  return slots;
}

/*********************************
 * 3) Bucket POS & Oven histories *
 *********************************/
function bucketPOS(pos) {
  // Map: sku -> Map(slotTsStr -> qty)
  const map = new Map();
  for (const e of pos) {
    const ts = floorToSlot(parseLocal(e.date));
    const key = ts.getTime().toString();
    if (!map.has(e.sku)) map.set(e.sku, new Map());
    const m = map.get(e.sku);
    m.set(key, (m.get(key) || 0) + e.qty);
  }
  return map;
}

function bucketOven(ovenLogs) {
  // Map: sku -> array of {tsStart, oven, rack, qty}
  const map = new Map();
  for (const e of ovenLogs) {
    const tsStart = floorToSlot(parseLocal(e.date));
    if (!map.has(e.sku)) map.set(e.sku, []);
    map.get(e.sku).push({ tsStart, oven: e.oven, rack: e.rack, qty: e.qty });
  }
  // sort by time
  for (const arr of map.values()) arr.sort((a, b) => a.tsStart - b.tsStart);
  return map;
}

/*******************************
 * 4) Simple demand forecasting *
 *******************************/
// Baseline: average of last same-time buckets (across available history)
function forecastDemand(sku, slots, posBuckets) {
  const skuBuckets = posBuckets.get(sku) || new Map();

  // group historical demand by slot offset (hour*60 + minute)
  const bySlotKey = new Map();
  for (const [k, v] of skuBuckets.entries()) {
    const d = new Date(Number(k));
    const slotKey = d.getHours() * 60 + d.getMinutes();
    if (!bySlotKey.has(slotKey)) bySlotKey.set(slotKey, []);
    bySlotKey.get(slotKey).push(v);
  }

  const result = new Map();
  for (const t of slots) {
    const slotKey = t.getHours() * 60 + t.getMinutes();
    const arr = bySlotKey.get(slotKey) || [];
    const avg = arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0;
    result.set(t.getTime().toString(), avg);
  }
  return result;
}

/******************************************
 * 5) Sellable inventory projection utils *
 ******************************************/
function getSkuCfg(sku) {
  const cfg = skuConfig.find(x => x.sku === sku);
  if (!cfg) throw new Error(`Missing config for ${sku}`);
  return cfg;
}

function sellableFromBatchAtTime(sku, batchTsStart, t) {
  const cfg = getSkuCfg(sku);
  const sinceStartMin = (t - batchTsStart) / MIN; // minutes
  // sellable if within [40, 120) minutes after bake start
  return (sinceStartMin >= (cfg.bake_min + cfg.cool_min)) && (sinceStartMin < cfg.sell_window_min[1]) ? 1 : 0;
}

function computeOnHandAt(sku, t, ovenBySku, plannedBatches) {
  const cfg = getSkuCfg(sku);
  const windowMin = [cfg.sell_window_min[0], cfg.sell_window_min[1]]; // [40,120]
  const earliest = addMinutes(t, -windowMin[1]);
  const latest = addMinutes(t, -windowMin[0]);

  let units = 0;
  // actual oven logs
  for (const b of (ovenBySku.get(sku) || [])) {
    if (b.tsStart >= earliest && b.tsStart <= latest) units += b.qty;
  }
  // planned but not yet baked
  for (const b of (plannedBatches.get(sku) || [])) {
    if (b.tsStart >= earliest && b.tsStart <= latest) units += b.qty;
  }
  return units; // units sellable at time t before POS depletions
}

/*******************************************
 * 6) Rack capacity & slot assignment model *
 *******************************************/
function capacityIndex(ovenCfg) {
  // key: slotTsStr -> { totalRacks, used: [{oven,rack,sku,qty}], free: number }
  return new Map();
}

function ensureSlotCapacity(slotIdx, ts) {
  const key = ts.getTime().toString();
  if (!slotIdx.has(key)) {
    const totalRacks = ovenConfig.reduce((a, o) => a + o.racks, 0);
    slotIdx.set(key, { totalRacks, used: [] });
  }
  return slotIdx.get(key);
}

function nextAssignableRack(usedList) {
  // simple allocator: fill oven1 racks 1..N then oven2
  const taken = new Set(usedList.map(u => `${u.oven}:${u.rack}`));
  for (const ov of ovenConfig) {
    for (let r = 1; r <= ov.racks; r++) {
      const id = `${ov.oven_id}:${r}`;
      if (!taken.has(id)) return { oven: ov.oven_id, rack: r };
    }
  }
  return null;
}

/****************************
 * 7) Planner (rolling 3 hrs)
 ****************************/
function planBakes({ now = new Date("2025-10-23T05:00:00") , horizonMin  }) {
  const start = floorToSlot(now);
  const end = addMinutes(start, horizonMin + 1); // inclusive-ish
  const slots = rangeSlots(start, end);

  const posBuckets = bucketPOS(posData);
  const ovenBySku = bucketOven(ovenLogs);

  const skus = skuConfig.map(s => s.sku);

  // Build cumulative POS up to t for depletion
  const posCumBySku = new Map(); // sku -> Map(slotTsStr -> cumulative sold up to t)
  for (const sku of skus) {
    const m = new Map();
    let cum = 0;
    for (const t of slots) {
      const key = t.getTime().toString();
      const sold = (posBuckets.get(sku) || new Map()).get(key) || 0;
      cum += sold;
      m.set(key, cum);
    }
    posCumBySku.set(sku, m);
  }

  


  // Demand forecast for each sku over horizon
  const demandBySku = new Map();
  for (const sku of skus) demandBySku.set(sku, forecastDemand(sku, slots, posBuckets));

// 2a) Build cumulative *forecast* per slot
  const forecastCumBySku = new Map(); // sku -> Map(slotTsStr -> cumulative forecast up to *this* slot)
for (const sku of skus) {
  const cum = new Map();
  let running = 0;
  for (const t of slots) {
    const key = t.getTime().toString();
    const f = (demandBySku.get(sku).get(key) || 0);
    running += f;
    cum.set(key, running);
  }
  forecastCumBySku.set(sku, cum);
}

  // Plans we will add incrementally
  const plannedBatches = new Map(); // sku -> [{tsStart, oven, rack, qty}]
  const slotCapacity = capacityIndex(ovenConfig);

  function addPlannedBatch(sku, tsStart, qty) {
    // assign rack at tsStart
    const cap = ensureSlotCapacity(slotCapacity, tsStart);
    const rack = nextAssignableRack(cap.used);
    if (!rack) return null; // no capacity
    const entry = { tsStart, oven: rack.oven, rack: rack.rack, sku, qty };
    cap.used.push(entry);
    if (!plannedBatches.has(sku)) plannedBatches.set(sku, []);
    plannedBatches.get(sku).push(entry);
    return entry;
  }

  const actions = []; // human-readable instructions

  for (const t of slots) {
    for (const sku of skus) {
      const cfg = getSkuCfg(sku);
      const demand = (demandBySku.get(sku).get(t.getTime().toString()) || 0);

      // Sellable stock before POS depletion
      let onHand = computeOnHandAt(sku, t, ovenBySku, plannedBatches);
      
      // Deplete by *forecasted* sales up to the previous slot

      const prevKey = addMinutes(t, -SLOT_MIN).getTime().toString();
      const soldCumForecast = (forecastCumBySku.get(sku).get(prevKey) || 0);
      onHand = Math.max(0, onHand - soldCumForecast);

      

      const safety = 0; // tweakable per SKU/time
      let shortfall = Math.max(0, demand + safety - onHand);

      while (shortfall > 0) {
        const batch = shortfall <= 6 ? 6 : 12; // simple chooser
        // Just-in-time target: bakeStart = t - (bake+cool)
        const bakeStartTarget = addMinutes(t, -(cfg.bake_min + cfg.cool_min)); // t-40
        // If that slot is busy, try earlier within sellable window [t-120, t-40]
        const earliest = addMinutes(t, -cfg.sell_window_min[1]); // t-120
        let scheduled = null;
        for (let ts = bakeStartTarget; ts >= earliest; ts = addMinutes(ts, -SLOT_MIN)) {
          const cap = ensureSlotCapacity(slotCapacity, ts);
          if (cap.used.length < cap.totalRacks) {
            const entry = addPlannedBatch(sku, ts, batch);
            if (entry) { scheduled = entry; break; }
          }
        }
        if (!scheduled) {
          actions.push({
            type: "EXCEPTION",
            message: `Capacity full for ${sku}; cannot meet demand at ${fmt(t)} within freshness window`,
          });
          // break to avoid infinite loop
          break;
        }
        // Update projections: adding this batch will be sellable at t (since ts within window)
        shortfall = Math.max(0, shortfall - batch);
      }
    }
  }

  // Build flattened plan from slotCapacity.used
  const plan = [];
  for (const [tsKey, cap] of slotCapacity.entries()) {
    for (const u of cap.used) {
      plan.push({
        start: new Date(Number(tsKey)),
        oven: u.oven,
        rack: u.rack,
        sku: u.sku,
        qty: u.qty,
        state: "planned",
      });
    }
  }
  plan.sort((a, b) => a.start - b.start || a.oven.localeCompare(b.oven) || a.rack - b.rack);

  return { plan, actions };
}

/*********************
 * 8) Run & printout *
 *********************/
if (require.main === module) {
  const now = new Date("2025-10-23T05:00:00"); // tweak as needed
  const { plan, actions } = planBakes({ now, horizonMin });
  console.log(`\n=== RECOMMENDED BAKE SCHEDULE (next ${horizonHour} h) ===\n`);
  for (const p of plan) {
    console.log(
      `${p.start.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} | ${p.oven} r${p.rack} | ${p.sku} x${p.qty} (${p.state})`
    );
  }
  if (actions.length) {
    console.log("\n=== EXCEPTIONS ===");
    for (const a of actions) console.log(`- ${a.message}`);
  }
}

module.exports = { planBakes, datasets: { skuConfig, ovenConfig, posData, ovenLogs } };
