import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // Fetch oldest pending task
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) throw error;

    if (!tasks || tasks.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No pending tasks"
      });
    }

    const task = tasks[0];

    // Mark processing
    await supabase
      .from("tasks")
      .update({ status: "processing" })
      .eq("id", task.id);

    let result = "";

    switch (task.action) {
      case "deploy_cart2save":
        result = "Cart2Save deployment triggered";
        break;

      case "run_quickscanz_scan":
        result = "QuickScanZ scan executed";
        break;

      case "run_pmil_scan":
        result = "PMIL scan executed";
        break;

      case "run_quietkeep_sync":
        result = "QuietKeep sync completed";
        break;

      default:
        result = `Unknown action: ${task.action}`;
    }

    // Mark completed
    await supabase
      .from("tasks")
      .update({
        status: "completed",
        result
      })
      .eq("id", task.id);

    // Audit log
    await supabase.from("audit_log").insert({
      action: task.action,
      result: result
    });

    return res.status(200).json({
      success: true,
      processed: task.action,
      result
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
