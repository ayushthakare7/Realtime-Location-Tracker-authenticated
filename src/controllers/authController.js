const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const emailService = require("../services/email.service")

// Register User
exports.register = async (req, res) => {
    try {

        const {
            username,
            email,
            password
        } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "All fields are required"
            });
        }

        const existingUser = await User.findOne({
            $or: [
                { email },
                { username }
            ]
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: "User already exists"
            });
        }

        const hashedPassword =
            await bcrypt.hash(password, 10);

        const user = await User.create({
            username,
            email,
            password: hashedPassword
        });

        res.status(201).json({
            success: true,
            
            message: "User registered successfully",
            userId: user._id,
            email : user.email,
            name : user.username
        });

        await emailService.sendRegistrationEmail(user.email, user.username) 

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

   


exports.login = async (req, res) => {
    try {

        const {
            email,
            password
        } = req.body;

        const user =
            await User.findOne({ email });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const isMatch =
            await bcrypt.compare(
                password,
                user.password
            );

        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        const token =
            jwt.sign(
                {
                    userId: user._id,
                    username: user.username
                },
                process.env.JWT_SECRET,
                {
                    expiresIn: "7d"
                }
            );

        res.status(200).json({
            success: true,
            token
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};