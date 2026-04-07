export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing id' });
  }

  const SANITY_ID = process.env.SANITY_PROJECT_ID;
  const SANITY_DATASET = process.env.SANITY_DATASET;
  const SANITY_TOKEN = process.env.SANITY_TOKEN;

  try {
    const response = await fetch(
      `https://${SANITY_ID}.api.sanity.io/v2024-01-01/data/mutate/${SANITY_DATASET}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SANITY_TOKEN}`,
        },
        body: JSON.stringify({
          mutations: [{ patch: { id, inc: { likes: 1 } } }],
        }),
      }
    );

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to patch like' });
  }
}
