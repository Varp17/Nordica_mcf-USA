import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import Joi from "joi";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";
import { sendOTPEmail, sendWelcomeEmail, sendPasswordResetOTPEmail, sendPasswordChangedEmail, sendContactChangeOTPEmail } from "../services/emailService.js";
import rateLimit from "express-rate-limit";
import logger from "../utils/logger.js";

const router = express.Router();
const customerRouter = express.Router();

/**
 * ── Rate Limiting ─────────────────────────────────────────────────────────────
 */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 20, 
  message: { success: false, message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 5, 
  message: { success: false, message: "Too many OTP requests. Please wait 5 minutes." },
});

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  firstName: Joi.string().min(2).required(),
  lastName: Joi.string().min(2).required(),
  phoneNumber: Joi.string().allow('', null).optional(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

function generateSecureOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * SHARED REGISTRATION LOGIC
 */
async function handleRegister(req, res) {
  const connection = await db.getConnection();
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { email, password, firstName, lastName, phoneNumber } = value;
    await connection.beginTransaction();

    const [existingUsers] = await connection.execute(
      "SELECT id, is_email_verified FROM users WHERE email = ? FOR UPDATE", 
      [email]
    );

    let userId;
    let isExistingUnverified = false;

    if (existingUsers.length > 0) {
      if (existingUsers[0].is_email_verified) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: "User already exists with this email" });
      }
      userId = existingUsers[0].id;
      isExistingUnverified = true;
    } else {
      userId = uuidv4();
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const otpCode = generateSecureOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    if (isExistingUnverified) {
      await connection.execute(
        `UPDATE users SET password_hash = ?, first_name = ?, last_name = ?, phone = ?, otp_code = ?, otp_expiry = ?, updated_at = NOW() 
         WHERE id = ?`,
        [passwordHash, firstName, lastName, phoneNumber || null, otpCode, otpExpiry, userId]
      );
    } else {
      await connection.execute(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, otp_code, otp_expiry, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, 'customer', ?, ?, NOW())`,
        [userId, email, passwordHash, firstName, lastName, phoneNumber || null, otpCode, otpExpiry],
      );
      const cartId = uuidv4();
      await connection.execute("INSERT INTO carts (id, user_id, created_at) VALUES (?, ?, NOW())", [cartId, userId]);
    }

    await connection.commit();
    try { await sendOTPEmail(email, otpCode); } catch (e) { logger.error("Registration OTP error:", e); }

    const token = jwt.sign({ userId, email, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      success: true,
      message: "Registration successful. Please check your email for a verification code.",
      token,
      requiresVerification: true,
      user: { id: userId, email, first_name: firstName, last_name: lastName, role: "customer", is_email_verified: 0 }
    });
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`Registration error: ${error.message}`);
    res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
}

/**
 * ── Root Routes (Elevated for Frontend Compatibility) ───────────────────────────
 */

router.post("/register", authRateLimit, handleRegister);

router.post("/login", authRateLimit, async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { email, password } = value;
    const [users] = await db.execute(
      `SELECT id, email, password_hash, first_name, last_name, phone, 
              address1, address2, city, state, zip, country, role, is_email_verified 
       FROM users WHERE email = ?`,
      [email]
    );

    if (users.length === 0) return res.status(401).json({ success: false, message: "Invalid email or password" });
    const user = users[0];

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    if (!user.is_email_verified && user.role !== 'admin') {
      const otpCode = generateSecureOTP();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
      await db.execute("UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?", [otpCode, otpExpiry, user.id]);
      try { await sendOTPEmail(user.email, otpCode); } catch (e) { logger.error("Login OTP error:", e); }

      return res.json({
        success: true,
        message: "Verification required",
        token,
        requiresVerification: true,
        user: { id: user.id, email: user.email, role: user.role, is_email_verified: 0 }
      });
    }

    await db.execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: { ...user, password_hash: undefined }
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/**
 * ── Customer Sub-Router ────────────────────────────────────────────────────────
 */
customerRouter.post("/register", authRateLimit, handleRegister);

customerRouter.post("/verify-otp", authenticateToken, async (req, res) => {
  try {
    const { otpCode } = req.body;
    if (!otpCode) return res.status(400).json({ success: false, message: "OTP code is required" });

    const [users] = await db.execute("SELECT email, first_name, otp_code, otp_expiry FROM users WHERE id = ?", [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    if (!user.otp_code || user.otp_code !== otpCode) return res.status(400).json({ success: false, message: "Invalid code" });
    if (new Date() > new Date(user.otp_expiry)) return res.status(400).json({ success: false, message: "Code expired" });

    await db.execute("UPDATE users SET is_email_verified = 1, otp_code = NULL, otp_expiry = NULL, updated_at = NOW() WHERE id = ?", [req.user.id]);
    sendWelcomeEmail(user.email, user.first_name).catch(e => logger.error("Welcome email failure:", e));

    res.json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    logger.error(`Verify OTP error: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

customerRouter.post("/resend-otp", authenticateToken, otpRateLimit, async (req, res) => {
  try {
    const [users] = await db.execute("SELECT email FROM users WHERE id = ?", [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });

    const otpCode = generateSecureOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.execute("UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?", [otpCode, otpExpiry, req.user.id]);
    await sendOTPEmail(users[0].email, otpCode);

    res.json({ success: true, message: "Verification code sent." });
  } catch (error) {
    logger.error(`Resend OTP error: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

customerRouter.get("/me", authenticateToken, async (req, res) => {
  try {
    const [users] = await db.execute("SELECT id, email, first_name, last_name, phone, address1, address2, city, state, zip, country, role, is_email_verified FROM users WHERE id = ?", [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, user: users[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * ── Guest & Password Recovery ─────────────────────────────────────────────────
 */
router.post("/guest-otp", otpRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    await db.execute("DELETE FROM guest_verifications WHERE email = ?", [email]);
    const otpCode = generateSecureOTP();
    await db.execute("INSERT INTO guest_verifications (email, otp_code, otp_expiry, created_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())", [email, otpCode]);
    await sendOTPEmail(email, otpCode);

    res.json({ success: true, message: "Code sent." });
  } catch (error) {
    logger.error(`Guest OTP error: ${error.message}`);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.post("/guest-verify", async (req, res) => {
  try {
    const { email, otpCode } = req.body;
    const [rows] = await db.execute("SELECT otp_code, otp_expiry FROM guest_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1", [email]);
    if (!rows.length || rows[0].otp_code !== otpCode || new Date() > new Date(rows[0].otp_expiry)) {
      return res.status(400).json({ success: false, message: "Invalid or expired code" });
    }
    res.json({ success: true, message: "Verified." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

customerRouter.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const [users] = await db.execute("SELECT id FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.json({ success: true, message: "If an account exists, a code has been sent." });

    const otpCode = generateSecureOTP();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await db.execute("UPDATE users SET otp_code = ?, otp_expiry = ? WHERE id = ?", [otpCode, otpExpiry, users[0].id]);
    await sendPasswordResetOTPEmail(email, otpCode);
    res.json({ success: true, message: "Reset code sent." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

customerRouter.post("/reset-password", async (req, res) => {
  try {
    const { email, otpCode, newPassword } = req.body;
    const [users] = await db.execute("SELECT id, first_name, otp_code, otp_expiry FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    const user = users[0];

    if (user.otp_code !== otpCode || new Date() > new Date(user.otp_expiry)) return res.status(400).json({ success: false, message: "Invalid or expired code" });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.execute("UPDATE users SET password_hash = ?, otp_code = NULL, otp_expiry = NULL WHERE id = ?", [hash, user.id]);
    sendPasswordChangedEmail(email, user.first_name).catch(e => {});
    res.json({ success: true, message: "Password reset successful." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.use("/customer", customerRouter);

export default router;