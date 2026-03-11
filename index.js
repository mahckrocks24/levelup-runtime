require("dotenv").config()
const express = require("express")

const app = express()

const PORT = process.env.PORT || 3000

app.get("/", (req, res) => {
  res.send("LevelUp Runtime is alive 🚀")
})

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.listen(PORT, () => {
  console.log("LevelUp Runtime listening on port " + PORT)
})
