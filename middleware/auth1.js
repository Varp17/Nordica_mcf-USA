// import jwt from "jsonwebtoken";
// import db from "../config/database.js";

// export const authenticateToken = async (req, res, next) => {
//   const authHeader = req.headers["authorization"]
//   const token = authHeader && authHeader.split(" ")[1]

//   if (!token) {
//     return res.status(401).json({ error: "Access token required" })
//   }

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET)

//     // Get user from database to ensure they still exist
//     const [users] = await db.execute("SELECT id, email, first_name, last_name, role FROM users WHERE id = ?", [
//       decoded.userId,
//     ])

//     if (users.length === 0) {
//       return res.status(401).json({ error: "User not found" })
//     }

//     req.user = users[0]
//     next()
//   } catch (error) {
//     if (error.name === "TokenExpiredError") {
//       return res.status(401).json({ error: "Token expired" })
//     }
//     return res.status(403).json({ error: "Invalid token" })
//   }
// }

// export const requireAdmin = (req, res, next) => {
//   if (req.user.role !== "admin") {
//     return res.status(403).json({ error: "Admin access required" })
//   }
//   next()
// }

// export const optionalAuth = async (req, res, next) => {
//   const authHeader = req.headers["authorization"]
//   const token = authHeader && authHeader.split(" ")[1]

//   if (!token) {
//     req.user = null
//     return next()
//   }

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET)

//     const [users] = await db.execute("SELECT id, email, first_name, last_name, role FROM users WHERE id = ?", [
//       decoded.userId,
//     ])

//     req.user = users.length > 0 ? users[0] : null
//   } catch (error) {
//     req.user = null
//   }

//   next()
// }

//testing (23-1-2026)



import jwt from "jsonwebtoken";

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};
