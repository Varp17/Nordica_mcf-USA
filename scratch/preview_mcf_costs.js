
import mcfService from '../services/mcfService.js';
import dotenv from 'dotenv';
dotenv.config();

async function runPreview() {
    console.log("--- MCF SHIPPING PREVIEW TEST ---");
    
    // Example address
    const address = {
        name: "Test Customer",
        line1: "123 Main St",
        city: "San Diego",
        stateOrRegion: "CA",
        postalCode: "92101",
        countryCode: "US",
        phone: "1234567890"
    };

    // Example items (Dirt Lock Pad Washer System)
    const items = [
        { sku: "DIRT LOCK-PWSBL", quantity: 1 }
    ];

    try {
        console.log(`Fetching preview for ${items[0].sku}...`);
        const previews = await mcfService.getFulfillmentPreview(address, items);
        
        const flatRates = {
            'Standard': 5.00,
            'Expedited': 7.00,
            'Priority': 15.00
        };

        console.log("\n[MCF COST ANALYSIS RESULTS]");
        console.log("-------------------------------------------------------------------------------");
        console.log("| Speed     | Amazon Fee | Customer Pays | Profit/Loss | Status  | Alert      |");
        console.log("-------------------------------------------------------------------------------");
        
        previews.forEach(p => {
            const customerCharge = flatRates[p.shippingSpeedCategory] || 0;
            const margin = (customerCharge - p.totalFee).toFixed(2);
            const status = p.isFulfillable ? "OK" : "NO";
            const alert = (customerCharge - p.totalFee) < -8.00 ? "!! LOSS !!" : "        ";
            
            console.log(`| ${p.shippingSpeedCategory.padEnd(9)} | $${p.totalFee.toString().padEnd(9)} | $${customerCharge.toString().padEnd(12)} | $${margin.toString().padEnd(10)} | ${status.padEnd(7)} | ${alert} |`);
        });
        console.log("-------------------------------------------------------------------------------");
        
    } catch (err) {
        console.error("Preview failed:", err.message);
    }
}

runPreview();
