/**
 * Shipping Calculator for Amazon MCF (USA)
 * Implements the 6-step formula for accurate cost estimation.
 */

export function calculateMCFShipping(items) {
  if (!items || items.length === 0) return 0;

  // 1. Calculate total actual weight and DIM weight for the whole shipment
  // Note: For multi-item orders, we simplify by summing billable weights or calculating total volume.
  // Amazon logic: Usually depends on how many boxes are used.
  // Our simplified approach: Calculate per-item and sum, or calculate total volume if preferred.
  // Given the prompt, we'll implement the per-item logic and sum them up, 
  // as each "unit" in MCF often has its own fulfillment fee.

  let totalCost = 0;

  for (const item of items) {
    const qty = item.quantity || 1;
    const itemCost = calculateUnitShipping(item);
    totalCost += itemCost * qty;
  }

  // 6. Final cost (no markup — this is a fallback estimate only)
  const finalShipping = Math.round(totalCost * 100) / 100;
  
  return finalShipping;
}

function calculateUnitShipping(item) {
  const { weightLb, dimensionsImperial } = item;
  
  // Default values if missing
  const actualWeight = parseFloat(weightLb) || 1.1; 
  let L = 10, W = 10, H = 1; // Default dimensions if missing

  if (dimensionsImperial && dimensionsImperial.includes('x')) {
    const parts = dimensionsImperial.split('x').map(p => parseFloat(p.replace(/[^\d.]/g, '')));
    if (parts.length === 3) {
      [L, W, H] = parts;
    }
  }

  // Step 1: Sort dimensions
  const dims = [L, W, H].sort((a, b) => b - a);
  const longest = dims[0];
  const median = dims[1];
  const shortest = dims[2];

  // Step 2: DIM weight
  // Formula: (L * W * H) / 139
  const dimWeight = (L * W * H) / 139;

  // Step 3: Billable weight
  const billableWeight = Math.max(actualWeight, dimWeight);

  // Step 4: Size Tier Logic
  // if longest <= 14 AND median <= 12 AND shortest <= 8: size_tier = "Large Standard"
  let sizeTier = "Oversize";
  if (longest <= 14 && median <= 12 && shortest <= 8) {
    sizeTier = "Large Standard";
  }

  // Step 5: Base cost lookup
  let cost = 15; // Default for Oversize or unknown

  if (sizeTier === "Large Standard") {
    if (billableWeight <= 1) cost = 5;
    else if (billableWeight <= 2) cost = 6.5;
    else if (billableWeight <= 3) cost = 7.5;
    else if (billableWeight <= 4) cost = 8.5;
    else if (billableWeight <= 5) cost = 9.5;
    else cost = 10.5;
  } else {
    // Oversize logic - typical MCF oversize starts higher
    cost = 15 + (billableWeight > 5 ? (billableWeight - 5) * 0.5 : 0);
  }

  // Step 6: Advanced Accuracy Boost
  // if longest > 13.8: final_shipping += 1
  if (longest > 13.8) {
    cost += 1;
  }

  return cost;
}

export default {
  calculateMCFShipping
};
