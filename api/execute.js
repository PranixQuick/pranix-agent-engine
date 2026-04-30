import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { action } = req.body;

    // 1. Insert task
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert([{ action, status: 'received' }])
      .select()
      .single();

    if (taskError) throw taskError;

    // 2. Log event
    await supabase.from('audit_log').insert([
      {
        action,
        status: 'logged',
        task_id: task.id
      }
    ]);

    // 3. Return response
    return res.status(200).json({
      success: true,
      task_id: task.id,
      message: `Action "${action}" stored ✅`
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
