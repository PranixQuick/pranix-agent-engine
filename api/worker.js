import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // 1. Get pending tasks
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("state", "pending")
      .limit(1);

    if (error) throw error;

    if (!tasks || tasks.length === 0) {
      return res.json({ message: "No tasks" });
    }

    const task = tasks[0];

    const action = task.input?.action;

    // 2. Execute logic (simple for now)
    let result = "";

    if (action === "deploy_cart2save") {
      result = "Cart2Save deployment triggered 🚀";
    } else {
      result = "Unknown action";
    }

    // 3. Update task
    await supabase
      .from("tasks")
      .update({ state: "completed" })
      .eq("id", task.id);

    return res.json({
      success: true,
      action,
      result,
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
