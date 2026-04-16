export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({error: 'Method not allowed'});
  }

  const SANITY_ID = process.env.SANITY_PROJECT_ID || 'ty87kenq';
  const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
  const query = encodeURIComponent('*[_type=="project"]{_id,likes}');
  const url = `https://${SANITY_ID}.apicdn.sanity.io/v2024-01-01/data/query/${SANITY_DATASET}?query=${query}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({error: 'Failed to fetch likes'});
    }

    const data = await response.json();
    const likes = Object.fromEntries(
      (data.result || []).map((project) => [project._id, project.likes || 0])
    );

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    return res.status(200).json({likes});
  } catch (error) {
    return res.status(500).json({error: 'Failed to fetch likes'});
  }
}
