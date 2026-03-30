import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import Joi from "joi";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";
import { sendOTPEmail, sendWelcomeEmail, sendPasswordResetOTPEmail, sendPasswordChangedEmail, sendContactChangeOTPEmail } from "../services/emailService.js";

const router = express.Router()

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  firstName: Joi.string().min(2).required(),
  lastName: Joi.string().min(2).required(),
  phoneNumber: Joi.string().allow('', null).optional(),
})

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
})

// Register
router.post("/register", async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { error, value } = registerSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message })
    }

    const { email, password, firstName, lastName, phoneNumber } = value

    await connection.beginTransaction();

    // Check if user already exists
    const [existingUsers] = await connection.execute(
      "SELECT id, is_email_verified FROM users WHERE email = ?", 
      [email]
    )

    let userId;
    let isExistingUnverified = false;

    if (existingUsers.length > 0) {
      const user = existingUsers[0];
      if (user.is_email_verified) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: "User already exists with this email" })
      }
      // User exists but is not verified - we'll update the record
      userId = user.id;
      isExistingUnverified = true;
    } else {
      userId = uuidv4();
    }

    // Hash password
    const saltRounds = 12
    const passwordHash = await bcrypt.hash(password, saltRounds)

    if (isExistingUnverified) {
      // Update existing unverified user - now mark as verified automatically
      await connection.execute(
        `UPDATE users SET password_hash = ?, first_name = ?, last_name = ?, phone = ?, is_email_verified = 1, updated_at = NOW() 
         WHERE id = ?`,
        [passwordHash, firstName, lastName, phoneNumber || null, userId]
      )
    } else {
      // Create new user - now mark as verified automatically
      await connection.execute(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, is_email_verified) 
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [userId, email, passwordHash, firstName, lastName, phoneNumber || null],
      )

      // Create cart for user
      const cartId = uuidv4()
      await connection.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, userId])
    }

    // SKIP OTP FOR NOW (As requested)
    /*
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await connection.execute(
      "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?",
      [otpCode, otpExpiry, userId]
    );
    */

    await connection.commit();

    // Fire and forget welcome email since we're verified now
    sendWelcomeEmail(email, firstName).catch(welcomeErr => {
      console.error("Background Welcome email failure:", welcomeErr);
    });

    // Generate JWT token
    const token = jwt.sign({ userId, email, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" })

    res.status(201).json({
      success: true,
      message: "User registered successfully.",
      token,
      requiresVerification: false,
      user: {
        id: userId,
        email,
        first_name: firstName,
        last_name: lastName,
        phone_number: phoneNumber,
        role: "customer",
        is_email_verified: 1
      },
    })
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Registration error:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  } finally {
    if (connection) connection.release();
  }
})

// Login
router.post("/login", async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ error: error.details[0].message })
    }

    const { email, password } = value

    // Get user from database
    const [users] = await db.execute(
      "SELECT id, email, password_hash, first_name, last_name, phone, role, is_email_verified FROM users WHERE email = ?",
      [email],
    )

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid email or password" })
    }

    const user = users[0]

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash)
    if (!isValidPassword) {
      return res.status(401).json({ success: false, message: "Invalid email or password" })
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    })

    // Force verification on login for now (as requested)
    if (!user.is_email_verified) {
      await db.execute("UPDATE users SET is_email_verified = 1 WHERE id = ?", [user.id]);
    }

    // Update last login for verified users
    await db.execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id])

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        phone: user.phone,
        address1: user.address1,
        address2: user.address2,
        city: user.city,
        state: user.state,
        zip: user.zip,
        country: user.country,
        role: user.role,
        is_email_verified: 1
      },
    })
  } catch (error) {
    console.error("Login error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Verify OTP
router.post("/verify-otp", authenticateToken, async (req, res) => {
  try {
    const { otpCode } = req.body;
    const userId = req.user.id;

    if (!otpCode) {
      return res.status(400).json({ success: false, message: "OTP code is required" });
    }

    const [users] = await db.execute(
      "SELECT email, first_name, otp_code, otp_expiry FROM users WHERE id = ?",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = users[0];

    if (!user.otp_code || user.otp_code !== otpCode) {
      return res.status(400).json({ success: false, message: "Invalid verification code" });
    }

    if (new Date() > new Date(user.otp_expiry)) {
      return res.status(400).json({ success: false, message: "Verification code has expired" });
    }

    // Mark as verified
    await db.execute(
      "UPDATE users SET is_email_verified = 1, otp_code = NULL, otp_expiry = NULL WHERE id = ?",
      [userId]
    );

    // Fire and forget welcome email
    sendWelcomeEmail(user.email, user.first_name).catch(welcomeErr => {
      console.error("Background Welcome email failure:", welcomeErr);
    });

    res.json({
      success: true,
      message: "Email verified successfully"
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Resend OTP
router.post("/resend-otp", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [users] = await db.execute(
      "SELECT email FROM users WHERE id = ?",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.execute(
      "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?",
      [otpCode, otpExpiry, userId]
    );

    // Send OTP email with explicit check (as requested for reliability)
    try {
      const emailResult = await sendOTPEmail(users[0].email, otpCode);
      if (!emailResult.success) {
        throw new Error(emailResult.error || "Failed to send OTP email");
      }
    } catch (emailErr) {
      console.error("OTP email failure during resend:", emailErr);
      return res.status(500).json({ 
        success: false, 
        message: "Failed to send verification code. Please check your network or try again later." 
      });
    }

    res.json({
      success: true,
      message: "New verification code sent to your email"
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get current user
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const [users] = await db.execute(
      `SELECT id, email, first_name, last_name, phone, 
              address1, address2, city, state, zip, country,
              created_at as member_since, role, is_email_verified 
       FROM users WHERE id = ?`,
      [req.user.id],
    )

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }
    
    res.json({
      success: true,
      user: {
        ...users[0],
        is_email_verified: 1
      }
    });

    // const user = users[0]
    // res.json({
    //   id: user.id,
    //   email: user.email,
    //   firstName: user.first_name,
    //   lastName: user.last_name,
    //   phoneNumber: user.phone_number,
    //   profilePictureUrl: user.profile_picture_url,
    //   memberSince: user.member_since,
    //   role: user.role,
    //   isEmailVerified: user.is_email_verified,
    // })
  } catch (error) {
    console.error("Get user error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Logout (client-side token removal)
router.post("/logout", authenticateToken, (req, res) => {
  res.json({ message: "Logout successful" })
})

// Update Profile
router.put("/profile", authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone, address1, address2, city, state, zip, country } = req.body;
    const userId = req.user.id;

    await db.execute(
      `UPDATE users SET 
        first_name = ?, last_name = ?, phone = ?, 
        address1 = ?, address2 = ?, city = ?, state = ?, zip = ?, country = ?,
        updated_at = NOW() 
       WHERE id = ?`,
      [
        firstName || null, 
        lastName || null, 
        phone || null, 
        address1 || null, 
        address2 || null, 
        city || null, 
        state || null, 
        zip || null, 
        country || null, 
        userId
      ]
    );

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Forgot Password - Send OTP
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const [users] = await db.execute("SELECT id, first_name FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      // For security, don't reveal that the email doesn't exist
      return res.json({ success: true, message: "If an account exists with this email, you will receive a reset code shortly." });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.execute(
      "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?",
      [otpCode, otpExpiry, users[0].id]
    );

    await sendPasswordResetOTPEmail(email, otpCode);

    res.json({ success: true, message: "Reset code sent to your email." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Reset Password with OTP
router.post("/reset-password", async (req, res) => {
  try {
    const { email, otpCode, newPassword } = req.body;
    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const [users] = await db.execute(
      "SELECT id, first_name, otp_code, otp_expiry FROM users WHERE email = ?",
      [email]
    );

    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    if (!user.otp_code || user.otp_code !== otpCode) {
      return res.status(400).json({ success: false, message: "Invalid reset code" });
    }

    if (new Date() > new Date(user.otp_expiry)) {
      return res.status(400).json({ success: false, message: "Reset code has expired" });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await db.execute(
      "UPDATE users SET password_hash = ?, otp_code = NULL, otp_expiry = NULL WHERE id = ?",
      [passwordHash, user.id]
    );

    await sendPasswordChangedEmail(email, user.first_name);

    res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Request Password Change OTP (Logged in)
router.post("/request-password-change-otp", authenticateToken, async (req, res) => {
  try {
    const { currentPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword) {
      return res.status(400).json({ success: false, message: "Current password is required" });
    }

    const [users] = await db.execute("SELECT first_name, email, password_hash FROM users WHERE id = ?", [userId]);
    if (users.length === 0) return res.status(404).json({ error: "User not found" });
    
    const user = users[0];
    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    await db.execute(
      "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?",
      [otpCode, otpExpiry, userId]
    );

    await sendPasswordResetOTPEmail(user.email, otpCode); // Reusing password reset template for consistency

    res.json({ success: true, message: "Security verification code sent to your email." });
  } catch (error) {
    console.error("Request password change OTP error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Change Password (Logged in - OTP VERIFIED)
router.post("/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, otpCode } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword || !otpCode) {
      return res.status(400).json({ success: false, message: "All fields are required (Current Pass, New Pass, and OTP Code)" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
    }

    const [users] = await db.execute("SELECT first_name, email, password_hash, otp_code, otp_expiry FROM users WHERE id = ?", [userId]);
    if (users.length === 0) return res.status(404).json({ error: "User not found" });
    
    const user = users[0];

    // 1. Verify Current Password
    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    // 2. Verify OTP
    if (!user.otp_code || user.otp_code !== otpCode) {
      return res.status(400).json({ success: false, message: "Invalid verification code" });
    }

    if (new Date() > new Date(user.otp_expiry)) {
      return res.status(400).json({ success: false, message: "Verification code has expired" });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await db.execute(
       "UPDATE users SET password_hash = ?, otp_code = NULL, otp_expiry = NULL, updated_at = NOW() WHERE id = ?", 
       [passwordHash, userId]
    );

    await sendPasswordChangedEmail(user.email, user.first_name);

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Request Contact Update (Email/Phone)
router.post("/request-contact-update", authenticateToken, async (req, res) => {
  try {
    const { newEmail, newPhone } = req.body;
    const userId = req.user.id;

    if (!newEmail && !newPhone) {
      return res.status(400).json({ success: false, message: "New email or phone is required" });
    }

    // If email change, check if already exists
    if (newEmail) {
      const [existing] = await db.execute("SELECT id FROM users WHERE email = ? AND id != ?", [newEmail, userId]);
      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: "Email already in use" });
      }
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    await db.execute(
      "UPDATE users SET pending_email = ?, pending_phone = ?, otp_code = ?, otp_expiry = ? WHERE id = ?",
      [newEmail || null, newPhone || null, otpCode, otpExpiry, userId]
    );

    // Send OTP to the NEW email if provided, otherwise the current email
    const [user] = await db.execute("SELECT email FROM users WHERE id = ?", [userId]);
    const targetEmail = newEmail || user[0].email;
    
    await sendContactChangeOTPEmail(targetEmail, otpCode, newEmail ? 'email' : 'phone');

    res.json({ success: true, message: "Verification code sent." });
  } catch (error) {
    console.error("Request contact update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Verify Contact Update
router.post("/verify-contact-update", authenticateToken, async (req, res) => {
  try {
    const { otpCode } = req.body;
    const userId = req.user.id;

    if (!otpCode) return res.status(400).json({ success: false, message: "OTP code is required" });

    const [users] = await db.execute(
      "SELECT pending_email, pending_phone, otp_code, otp_expiry FROM users WHERE id = ?",
      [userId]
    );

    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    if (!user.otp_code || user.otp_code !== otpCode) {
      return res.status(400).json({ success: false, message: "Invalid verification code" });
    }

    if (new Date() > new Date(user.otp_expiry)) {
      return res.status(400).json({ success: false, message: "Verification code has expired" });
    }

    // Commit changes
    const updates = [];
    const params = [];
    if (user.pending_email) {
      updates.push("email = ?", "is_email_verified = 1");
      params.push(user.pending_email);
    }
    if (user.pending_phone) {
      updates.push("phone = ?");
      params.push(user.pending_phone);
    }

    if (updates.length > 0) {
      params.push(userId);
      await db.execute(
        `UPDATE users SET ${updates.join(", ")}, pending_email = NULL, pending_phone = NULL, otp_code = NULL, otp_expiry = NULL WHERE id = ?`,
        params
      );
    }

    res.json({ success: true, message: "Contact information updated successfully" });
  } catch (error) {
    console.error("Verify contact update error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;