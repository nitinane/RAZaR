// =============================================================
// seed_failed_payments.ts
//
// Generates synthetic failed-payment records for the Revenue
// Recovery Agent batch evaluation.
//
// Covers all root-cause categories with realistic distributions
// and edge cases so batch metrics (recovery rate, false-positive
// cost, escalation rate) are meaningful — not trivially easy.
//
// Usage (generate only — prints JSON):
//   npx tsx src/seed_failed_payments.ts
//
// Usage (generate + insert into Supabase):
//   SUPABASE_URL=<url> SUPABASE_KEY=<key> npx tsx src/seed_failed_payments.ts --seed
//
// Usage (seed the pre-built canonical batch from data/failed_payments.json):
//   SUPABASE_URL=<url> SUPABASE_KEY=<key> npx tsx src/seed_failed_payments.ts --seed --use-file
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type RootCauseCategory =
  | "bank_timeout"
  | "insufficient_funds"
  | "expired_mandate"
  | "gateway_error"
  | "unknown";

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet";

export interface FailedPaymentRecord {
  id: string;
  amount: number;           // in paise, Razorpay convention (100 = INR 1)
  currency: "INR";
  method: PaymentMethod;
  customer_id: string;
  mandate_id: string | null;
  failure_code: string;
  failure_reason_raw: string;
  attempt_number: number;
  max_attempts_allowed: number;
  true_root_cause: RootCauseCategory;
  ambiguity: "low" | "high";
  created_at: string;
}

// ─────────────────────────────────────────────────────────────
// Failure reason templates
// Each entry has the raw message the classifier/LLM will see,
// plus the "ambiguity" label that tells our eval whether the
// pre-classifier should have caught it without an LLM call.
// ─────────────────────────────────────────────────────────────

const FAILURE_REASON_TEMPLATES: Record<
  RootCauseCategory,
  { text: string; ambiguity: "low" | "high" }[]
> = {
  bank_timeout: [
    { text: "Issuing bank did not respond within timeout window (30s)", ambiguity: "low" },
    { text: "BANK_TIMEOUT: no response from acquirer",                  ambiguity: "low" },
    { text: "Transaction timed out at bank end, retry recommended",     ambiguity: "low" },
    {
      text: "Payment processing delayed, connection dropped mid-authorization",
      ambiguity: "high",   // could be gateway or bank
    },
  ],
  insufficient_funds: [
    { text: "Insufficient balance in customer account",   ambiguity: "low"  },
    { text: "INSUFFICIENT_FUNDS: declined by issuer",     ambiguity: "low"  },
    {
      text: "Transaction declined by bank",
      ambiguity: "high",   // deliberately vague — could be anything
    },
  ],
  expired_mandate: [
    { text: "UPI Autopay mandate has expired, re-authorization required",      ambiguity: "low"  },
    { text: "MANDATE_EXPIRED: recurring payment authorization no longer valid", ambiguity: "low"  },
    {
      text: "Standing instruction invalid, customer action needed",
      ambiguity: "high",   // could be mandate or account issue
    },
  ],
  gateway_error: [
    { text: "GATEWAY_ERROR: unexpected response code 502 from payment processor", ambiguity: "low"  },
    { text: "Internal gateway exception during authorization step",                ambiguity: "low"  },
    {
      text: "Payment processor returned malformed response",
      ambiguity: "high",
    },
  ],
  unknown: [
    { text: "Payment failed",              ambiguity: "high" }, // maximally unhelpful
    { text: "Transaction could not be completed", ambiguity: "high" },
    { text: "Error code UNSPECIFIED_9981", ambiguity: "high" },
  ],
};

const METHODS: PaymentMethod[] = ["upi", "card", "netbanking", "wallet"];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAmount(): number {
  // INR 100 – 50,000, converted to paise
  return Math.floor((Math.random() * 49_900 + 100) * 100);
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

function recentIso(maxDaysAgo = 7): string {
  return new Date(
    Date.now() - Math.floor(Math.random() * maxDaysAgo * 86_400_000)
  ).toISOString();
}

// ─────────────────────────────────────────────────────────────
// Generator
// ─────────────────────────────────────────────────────────────

/**
 * Generates a batch of synthetic failed-payment records.
 *
 * @param count - Number of regular records (default 60, covers the 50+ bar)
 * @param maxedCount - Additional records already at max attempts (exercises stop-rule)
 */
export function generateBatch(
  count = 60,
  maxedCount = 3
): FailedPaymentRecord[] {
  const categories = Object.keys(
    FAILURE_REASON_TEMPLATES
  ) as RootCauseCategory[];
  const records: FailedPaymentRecord[] = [];

  for (let i = 0; i < count; i++) {
    const category = randomFrom(categories);
    const template  = randomFrom(FAILURE_REASON_TEMPLATES[category]);

    // Expired mandates are almost exclusively UPI/recurring in India
    const method: PaymentMethod =
      category === "expired_mandate" ? "upi" : randomFrom(METHODS);

    // Realistic: ~70% of failures hit on first attempt
    const attemptNumber =
      Math.random() < 0.7 ? 1 : Math.floor(Math.random() * 2) + 2;

    // Recurring payments often have a mandate; some one-offs do too
    const hasMandateByCategory =
      category === "expired_mandate" || Math.random() < 0.3;

    records.push({
      id:                  `pay_${pad(i + 1, 4)}`,
      amount:              randomAmount(),
      currency:            "INR",
      method,
      customer_id:         `cust_${pad(Math.floor(Math.random() * 30) + 1, 3)}`,
      mandate_id:          hasMandateByCategory
                             ? `mandate_${pad(i + 1, 4)}`
                             : null,
      failure_code:        category.toUpperCase().replace(/_/g, "_"),
      failure_reason_raw:  template.text,
      attempt_number:      attemptNumber,
      max_attempts_allowed: 3,
      true_root_cause:     category,
      ambiguity:           template.ambiguity,
      created_at:          recentIso(),
    });
  }

  // Edge cases: records that have already hit the attempt limit.
  // These should be caught by the Stop-Rule Guard immediately.
  for (let i = 0; i < maxedCount; i++) {
    const category = randomFrom(categories);
    const template  = randomFrom(FAILURE_REASON_TEMPLATES[category]);
    records.push({
      id:                  `pay_maxed_${pad(i + 1, 2)}`,
      amount:              randomAmount(),
      currency:            "INR",
      method:              randomFrom(METHODS),
      customer_id:         `cust_${pad(Math.floor(Math.random() * 30) + 1, 3)}`,
      mandate_id:          null,
      failure_code:        category.toUpperCase(),
      failure_reason_raw:  template.text,
      attempt_number:      3,
      max_attempts_allowed: 3,
      true_root_cause:     category,
      ambiguity:           template.ambiguity,
      created_at:          new Date().toISOString(),
    });
  }

  return records;
}

// ─────────────────────────────────────────────────────────────
// Supabase seeder
// ─────────────────────────────────────────────────────────────

async function seedToSupabase(records: FailedPaymentRecord[]): Promise<void> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_KEY"];

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_KEY must be set to seed the database."
    );
  }

  const db = createClient(url, key);

  console.error(`\n[Seeder] Inserting ${records.length} records into failed_payments …`);

  // Upsert in batches of 20 to stay within Supabase row limits per request
  const BATCH = 20;
  let inserted = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const { error } = await db
      .from("failed_payments")
      .upsert(chunk, { onConflict: "id" });

    if (error) {
      throw new Error(`[Seeder] Batch ${i / BATCH + 1} failed: ${error.message}`);
    }
    inserted += chunk.length;
    process.stderr.write(`\r[Seeder] ${inserted}/${records.length} inserted …`);
  }

  process.stderr.write("\n");
  console.error(`[Seeder] Done. ${inserted} records in failed_payments.`);

  // Print category distribution to stderr for quick sanity check
  const dist = records.reduce((acc, r) => {
    acc[r.true_root_cause] = (acc[r.true_root_cause] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.error("[Seeder] Category distribution:", dist);

  const highAmbiguity = records.filter((r) => r.ambiguity === "high").length;
  const maxed         = records.filter(
    (r) => r.attempt_number >= r.max_attempts_allowed
  ).length;
  console.error(
    `[Seeder] High-ambiguity: ${highAmbiguity} | Already maxed: ${maxed}`
  );
}

// ─────────────────────────────────────────────────────────────
// Entry point (ESM-compatible: check import.meta.url)
// ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  const args     = process.argv.slice(2);
  const doSeed   = args.includes("--seed");
  const useFile  = args.includes("--use-file");

  // Resolve path to the canonical pre-built dataset
  const __dirname = dirname(__filename);
  const dataPath  = join(__dirname, "..", "data", "failed_payments.json");

  let records: FailedPaymentRecord[];

  if (useFile) {
    console.error(`[Seeder] Loading canonical dataset from ${dataPath}`);
    records = JSON.parse(readFileSync(dataPath, "utf-8")) as FailedPaymentRecord[];
    console.error(`[Seeder] Loaded ${records.length} records from file.`);
  } else {
    records = generateBatch(60, 3);
    console.error(`[Seeder] Generated ${records.length} records.`);
  }

  if (doSeed) {
    seedToSupabase(records).catch((err) => {
      console.error("[FATAL]", err.message);
      process.exit(1);
    });
  } else {
    // Default: just print JSON to stdout (pipe to a file if needed)
    console.log(JSON.stringify(records, null, 2));

    const dist = records.reduce((acc, r) => {
      acc[r.true_root_cause] = (acc[r.true_root_cause] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.error(`[Generator] ${records.length} records generated.`);
    console.error("[Generator] Category distribution:", dist);
  }
}

// Named export so other modules can import the generator directly
export { seedToSupabase };
