import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { action, payload } = req.body || {};

  // 🔹 PING TEST
  if (action === 'ping') {
    return res.status(200).json({
      success: true,
      message: 'Pranix engine live ✅'
    });
  }

  // 🔹 FETCH AGENTS
  if (action === 'get_agents') {
    const { data, error } = await supabase
      .from('agents')
      .select('*');

    return res.status(200).json({ data, error });
  }

  // 🔹 CREATE TASK
  if (action === 'create_task') {
    const { data, error } = await supabase
      .from('tasks')
      .insert([{ input: payload, state: 'pending' }]);

    return res.status(200).json({ data, error });
  }

  return res.status(200).json({
    success: true,
    received: { action, payload }
  });
}
