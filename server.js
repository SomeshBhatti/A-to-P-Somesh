require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("A-to-P server running");
});

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    pinterest: !!process.env.PINTEREST_ACCESS_TOKEN,
    openai: !!process.env.OPENAI_API_KEY,
  });
});

// =========================
// GET PINTEREST BOARDS
// =========================
app.get("/api/boards", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.pinterest.com/v5/boards",
      {
        headers: {
          Authorization: `Bearer ${process.env.PINTEREST_ACCESS_TOKEN}`,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: "Failed to fetch boards",
      details: error.response?.data || error.message,
    });
  }
});

// =========================
// CREATE PIN
// =========================
app.post("/api/post-pin", async (req, res) => {
  try {
    const { board_id, title, description, image_url, link } = req.body;

    const response = await axios.post(
      "https://api.pinterest.com/v5/pins",
      {
        board_id,
        title,
        description,
        link,
        media_source: {
          source_type: "image_url",
          url: image_url,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PINTEREST_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: "Failed to create pin",
      details: error.response?.data || error.message,
    });
  }
});

// =========================
// FALLBACK ROUTE
// =========================
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
