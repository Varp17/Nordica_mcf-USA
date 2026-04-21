
async function testSubmission() {
    const payload = {
        name: "Test User",
        email: "test@example.com",
        subject: "Verification Test",
        message: "This is a test message to verify the ticketing system.",
        country: "CA"
    };

    try {
        const response = await fetch("http://localhost:5000/api/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        console.log("Submission Response:", JSON.stringify(data, null, 2));

        if (data.success) {
            console.log("✅ Ticket created successfully:", data.ticket_number);
        } else {
            console.error("❌ Submission failed:", data.message);
        }
    } catch (error) {
        console.error("❌ Network error:", error.message);
    }
}

testSubmission();
