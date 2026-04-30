export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    // ✅ FIX: Proper body parsing
    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const { action } = body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: "Action missing in request body",
      });
    }

    // TEMP RESPONSE
    return res.status(200).json({
      success: true,
      message: `Action "${action}" received ✅`,
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
