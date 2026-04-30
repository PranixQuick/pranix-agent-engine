export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { action, payload } = req.body || {};

  if (action === 'ping') {
    return res.status(200).json({
      success: true,
      result: { message: 'Pranix engine live ✅' }
    });
  }

  return res.status(200).json({
    success: true,
    received: { action, payload }
  });
}
