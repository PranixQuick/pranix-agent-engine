export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { action, payload } = req.body;

  try {
    let result;

    if (action === "ping") {
      result = { message: "Pranix engine live ✅" };
    }

    else if (action === "echo") {
      result = { you_sent: payload };
    }

    else {
      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(200).json({
      success: true,
      action,
      result
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
