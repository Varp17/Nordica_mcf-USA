import express from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router()

// Get user profile
router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const [users] = await db.execute(
      `SELECT 
        id, email, first_name, last_name, phone_number, 
        profile_picture_url, member_since, is_email_verified
       FROM users WHERE id = ?`,
      [req.user.id],
    )

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }

    res.json(users[0])
  } catch (error) {
    console.error("Get profile error:", error)
    res.status(500).json({ error: "Failed to fetch profile" })
  }
})

// Update user profile
// router.put("/profile", authenticateToken, async (req, res) => {
//   try {
//     const { firstName, lastName, phoneNumber } = req.body

//     const safeFirstName = typeof firstName === "undefined" ? null : firstName
//     const safeLastName = typeof lastName === "undefined" ? null : lastName
//     const safePhone = typeof phoneNumber === "undefined" ? null : phoneNumber

//     await db.execute(
//       "UPDATE users SET first_name = ?, last_name = ?, phone_number = ?, updated_at = NOW() WHERE id = ?",
//       [safeFirstName, safeLastName, safePhone, req.user.id],
//     )

//     res.json({ message: "Profile updated successfully" })
//   } catch (error) {
//     console.error("Update profile error:", error)
//     res.status(500).json({ error: "Failed to update profile" })
//   }
// })
router.put("/profile", authenticateToken, async (req, res) => {

  const { first_name, last_name, phone_number } = req.body;
  const updateFields = [];
  const queryParams = [];

  // Build the query dynamically to avoid overwriting fields with null
  if (first_name !== undefined) {
    updateFields.push("first_name = ?");
    queryParams.push(first_name);
  }
  if (last_name !== undefined) {
    updateFields.push("last_name = ?");
    queryParams.push(last_name);
  }
  if (phone_number !== undefined) {
    updateFields.push("phone_number = ?");
    queryParams.push(phone_number);
  }

  if (updateFields.length === 0) {
    return res.status(400).json({ error: "No fields to update provided." });
  }
  
  queryParams.push(req.user.id);

  try {
    const sql = `UPDATE users SET ${updateFields.join(", ")}, updated_at = NOW() WHERE id = ?`;
    await db.execute(sql, queryParams);

    // BEST PRACTICE: Return the updated user object
    const [users] = await db.execute("SELECT id, email, first_name, last_name, phone_number FROM users WHERE id = ?", [req.user.id]);
    res.json({ message: "Profile updated successfully", user: users[0] });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Change password
router.put("/password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new passwords are required" })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" })
    }

    // Get current password hash
    const [users] = await db.execute("SELECT password_hash FROM users WHERE id = ?", [req.user.id])

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, users[0].password_hash)
    if (!isValidPassword) {
      return res.status(400).json({ error: "Current password is incorrect" })
    }

    // Hash new password
    const saltRounds = 12
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds)

    // Update password
    await db.execute("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [
      newPasswordHash,
      req.user.id,
    ])

    res.json({ message: "Password changed successfully" })
  } catch (error) {
    console.error("Change password error:", error)
    res.status(500).json({ error: "Failed to change password" })
  }
})

// Get user addresses
router.get("/addresses", authenticateToken, async (req, res) => {
  try {
    const [addresses] = await db.execute(
      `SELECT 
        id, address_line1, address_line2, city, state_province, 
        postal_code, country, phone_number, is_default
       FROM addresses WHERE user_id = ?
       ORDER BY is_default DESC, created_at DESC`,
      [req.user.id],
    )

    res.json(addresses)
  } catch (error) {
    console.error("Get addresses error:", error)
    res.status(500).json({ error: "Failed to fetch addresses" })
  }
})

// Add address
// router.post("/addresses", authenticateToken, async (req, res) => {
//   try {
//     const { address_line1, address_line2, city, state_province, postal_code, country, phone_number, is_default } = req.body

//     if (!address_line1 || !city || !state_province || !postal_code || !country || !phone_number) {
//       return res.status(400).json({ error: "All required address fields must be provided" })
//     }

//     const addressId = uuidv4()

//     // If this is set as default, unset other default addresses
//     if (isDefault) {
//       await db.execute("UPDATE addresses SET is_default = FALSE WHERE user_id = ?", [req.user.id])
//     }

//     await db.execute(
//       `INSERT INTO addresses 
//        (id, user_id, address_line1, address_line2, city, state_province, 
//         postal_code, country, phone_number, is_default) 
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//       [
//         addressId,
//         req.user.id,
//         addressLine1,
//         addressLine2 || null,
//         city,
//         stateProvince,
//         postalCode,
//         country,
//         phoneNumber,
//         isDefault || false,
//       ],
//     )

//     res.status(201).json({
//       message: "Address added successfully",
//       addressId,
//     })
//   } catch (error) {
//     console.error("Add address error:", error)
//     res.status(500).json({ error: "Failed to add address" })
//   }
// })

// // Update address
// router.put("/addresses/:id", authenticateToken, async (req, res) => {
//   try {
//     const fields = []
//     const values = []

//     const updatableFields = {
//       address_line1: req.body.addressLine1,
//       address_line2: req.body.addressLine2,
//       city: req.body.city,
//       state_province: req.body.stateProvince,
//       postal_code: req.body.postalCode,
//       country: req.body.country,
//       phone_number: req.body.phoneNumber,
//       is_default: req.body.isDefault
//     }

//     for (const [dbField, value] of Object.entries(updatableFields)) {
//       if (value !== undefined) {
//         fields.push(`${dbField} = ?`)
//         values.push(value)
//       }
//     }

//     if (fields.length === 0) {
//       return res.status(400).json({ error: "No fields provided to update" })
//     }

//     values.push(req.params.id, req.user.id)

//     const [result] = await db.execute(
//       `UPDATE addresses SET ${fields.join(", ")}, updated_at = NOW() WHERE id = ? AND user_id = ?`,
//       values
//     )

//     if (result.affectedRows === 0) {
//       return res.status(404).json({ error: "Address not found or not owned by user" })
//     }

//     res.json({ message: "Address updated successfully" })
//   } catch (error) {
//     console.error("Update address error:", error)
//     res.status(500).json({ error: "Failed to update address" })
//   }
// })
router.post("/addresses", authenticateToken, async (req, res) => {
  try {
    // THE FIX: Use snake_case to match the incoming request body
    const { address_line1, address_line2, city, state_province, postal_code, country, phone_number, is_default } = req.body;

    // This validation logic is now correct
    if (!address_line1 || !city || !state_province || !postal_code || !country || !phone_number) {
      return res.status(400).json({ error: "All required address fields must be provided" });
    }

    const addressId = uuidv4();

    // If this is set as default, unset other default addresses
    if (is_default) { // Use the corrected variable name
      await db.execute("UPDATE addresses SET is_default = FALSE WHERE user_id = ?", [req.user.id]);
    }

    await db.execute(
      `INSERT INTO addresses 
       (id, user_id, address_line1, address_line2, city, state_province, 
        postal_code, country, phone_number, is_default) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        addressId,
        req.user.id,
        address_line1,
        address_line2 || null,
        city,
        state_province,
        postal_code,
        country,
        phone_number,
        is_default || false, // Use the corrected variable name
      ],
    );

    res.status(201).json({
      message: "Address added successfully",
      addressId,
    });
  } catch (error) {
    console.error("Add address error:", error);
    res.status(500).json({ error: "Failed to add address" });
  }
});
router.put("/addresses/:id", authenticateToken, async (req, res) => {
  try {
    // THE FIX: Expect snake_case from the request body
    const { address_line1, address_line2, city, state_province, postal_code, country, phone_number, is_default } = req.body;
    
    // Use a transaction for safety, especially when changing the default address
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // If the user is trying to set this address as the default
      if (is_default === true) {
        await connection.execute("UPDATE addresses SET is_default = FALSE WHERE user_id = ? AND id != ?", [req.user.id, req.params.id]);
      }
      
      const updateFields = [];
      const queryParams = [];

      // Dynamically build the update query to only change fields that were provided
      if (address_line1 !== undefined) { updateFields.push("address_line1 = ?"); queryParams.push(address_line1); }
      if (address_line2 !== undefined) { updateFields.push("address_line2 = ?"); queryParams.push(address_line2); }
      if (city !== undefined) { updateFields.push("city = ?"); queryParams.push(city); }
      if (state_province !== undefined) { updateFields.push("state_province = ?"); queryParams.push(state_province); }
      if (postal_code !== undefined) { updateFields.push("postal_code = ?"); queryParams.push(postal_code); }
      if (country !== undefined) { updateFields.push("country = ?"); queryParams.push(country); }
      if (phone_number !== undefined) { updateFields.push("phone_number = ?"); queryParams.push(phone_number); }
      if (is_default !== undefined) { updateFields.push("is_default = ?"); queryParams.push(is_default); }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: "No fields provided to update" });
      }

      const sql = `UPDATE addresses SET ${updateFields.join(", ")}, updated_at = NOW() WHERE id = ? AND user_id = ?`;
      queryParams.push(req.params.id, req.user.id);
      
      const [result] = await connection.execute(sql, queryParams);
      
      await connection.commit();
      connection.release();

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Address not found or not owned by user" });
      }

      res.json({ message: "Address updated successfully" });

    } catch (innerError) {
      await connection.rollback();
      connection.release();
      throw innerError; // Rethrow to be caught by outer catch block
    }
  } catch (error) {
    console.error("Update address error:", error);
    res.status(500).json({ error: "Failed to update address" });
  }
});

// Delete address
router.delete("/addresses/:id", authenticateToken, async (req, res) => {
  try {
    // Verify address belongs to user
    const [addresses] = await db.execute("SELECT id FROM addresses WHERE id = ? AND user_id = ?", [
      req.params.id,
      req.user.id,
    ])

    if (addresses.length === 0) {
      return res.status(404).json({ error: "Address not found" })
    }

    await db.execute("DELETE FROM addresses WHERE id = ?", [req.params.id])

    res.json({ message: "Address deleted successfully" })
  } catch (error) {
    console.error("Delete address error:", error)
    res.status(500).json({ error: "Failed to delete address" })
  }
})

export default router;