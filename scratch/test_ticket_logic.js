
import Ticket from '../models/Ticket.js';
import db from '../config/database.js';

async function testLogic() {
    try {
        console.log("Testing Ticket.create logic...");
        const ticket = await Ticket.create({
            name: "Test User",
            email: "test@example.com",
            subject: "Logic Verification",
            message: "This is a direct model test.",
            country: "US"
        });

        console.log("✅ Ticket created in DB:", ticket.ticket_number);

        console.log("Testing Ticket.findAll...");
        const tickets = await Ticket.findAll({ country: "US" });
        console.log(`✅ Found ${tickets.length} tickets for US`);

        console.log("Testing Ticket.update...");
        const updated = await Ticket.update(ticket.id, { 
            status: 'resolved',
            response_message: "Test response"
        });
        console.log("✅ Ticket updated status:", updated.status);
        console.log("✅ Ticket response message:", updated.response_message);

        console.log("Cleanup: Deleting test ticket...");
        await db.query('DELETE FROM contact_tickets WHERE id = ?', [ticket.id]);
        console.log("✅ Cleanup complete");

        process.exit(0);
    } catch (err) {
        console.error("❌ Test failed:", err);
        process.exit(1);
    }
}

testLogic();
