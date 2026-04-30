import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const { action } = body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: "Action missing",
      });
    }

    // 🔥 Insert into Supabase
    const { data, error } =  await supabase.from("tasks").insert([
  {
    agent_id: null,
    input: { action },
    state: "pending",
  },
]);

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Task created 🚀",
      data,
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
