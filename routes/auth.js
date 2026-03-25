import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import Joi from "joi";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";
import { sendOTPEmail } from "../services/emailService.js";

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
  try {
    const { error, value } = registerSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message })
    }

    const { email, password, firstName, lastName, phoneNumber } = value

    // Check if user already exists
    const [existingUsers] = await db.execute("SELECT id FROM users WHERE email = ?", [email])

    if (existingUsers.length > 0) {
      return res.status(400).json({ success: false, message: "User already exists with this email" })
    }

    // Hash password
    const saltRounds = 12
    const passwordHash = await bcrypt.hash(password, saltRounds)

    // Create user
    const userId = uuidv4()
    const memberSince = new Date().toISOString().split("T")[0]

    await db.execute(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, phone) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, email, passwordHash, firstName, lastName, phoneNumber || null],
    )

    // Create cart for user
    const cartId = uuidv4()
    await db.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, userId])

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.execute(
      "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?",
      [otpCode, otpExpiry, userId]
    );

    // Send OTP email
    await sendOTPEmail(email, otpCode);

    // Generate JWT token (might be limited until verified)
    const token = jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" })

    res.status(201).json({
      success: true,
      message: "User registered successfully. Please check your email for the verification code.",
      token,
      requiresVerification: true,
      user: {
        id: userId,
        email,
        first_name: firstName,
        last_name: lastName,
        phone_number: phoneNumber,
        role: "customer",
        is_email_verified: 0
      },
    })
  } catch (error) {
    console.error("Registration error:", error)
    res.status(500).json({ error: "Internal server error" })
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
      "SELECT id, email, password_hash, first_name, last_name, phone, role FROM users WHERE email = ?",
      [email],
    )

    if (users.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    const user = users[0]

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash)
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid email or password" })
    }

    // Update last login
    await db.execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id])

    // Generate JWT token
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    })

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
        role: user.role,
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
      "SELECT otp_code, otp_expiry FROM users WHERE id = ?",
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

    await sendOTPEmail(users[0].email, otpCode);

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
              created_at as member_since, role, is_email_verified 
       FROM users WHERE id = ?`,
      [req.user.id],
    )

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }
    
    res.json({
      success: true,
      user: users[0]
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
      [firstName, lastName, phone, address1, address2, city, state, zip, country, userId]
    );

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;