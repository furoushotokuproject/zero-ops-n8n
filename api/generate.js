module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { title, description, nodes, services } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  const nodeList = Array.isArray(nodes) ? nodes.join(', ') : String(nodes || '');
  const svcList  = Array.isArray(services) ? services.join(', ') : String(services || '');

  const systemPrompt = [
    'You are an n8n workflow JSON generator.',
    'Output ONLY raw JSON. No markdown. No code blocks. No backticks. No explanation.',
    'Start your response with { and end with }.',
    'IMPORTANT: Use maximum 5 nodes. Keep the workflow simple and concise.',
    'The JSON must match this exact schema:',
    '{',
    '  "name": "string",',
    '  "nodes": [{ "id": "uuid", "name": "string", "type": "n8n-nodes-base.XXX", "typeVersion": 1, "position": [x, y], "parameters": {} }],',
    '  "connections": {},',
    '  "settings": { "executionOrder": "v1" }',
    '}',
    'Available node types: n8n-nodes-base.scheduleTrigger, n8n-nodes-base.webhook, n8n-nodes-base.manualTrigger,',
    'n8n-nodes-base.httpRequest, n8n-nodes-base.code, n8n-nodes-base.set, n8n-nodes-base.if,',
    'n8n-nodes-base.switch, n8n-nodes-base.merge, n8n-nodes-base.wait, n8n-nodes-base.respondToWebhook.',
    'Use realistic UUIDs for node ids. Space nodes 200px apart horizontally starting at [240, 300].',
  ].join('\n');

  const userPrompt = [
    'Generate an n8n workflow for:',
    'Title: ' + title,
    'Description: ' + description,
    'Nodes to use: ' + nodeList,
    'Services: ' + svcList,
    '',
    'IMPORTANT: Maximum 5 nodes. Output ONLY the JSON. Start with { and end with }. No backticks.',
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(502).json({ error: 'Anthropic API error', detail: err });
    }

    const data = await response.json();
    const raw = data.content.map(x => x.text || '').join('').trim();

    let jsonStr = raw;

    // Step1: コードブロック除去
    jsonStr = jsonStr.replace(/^[\s\S]*?```(?:json)?[\s]*/i, '');
    jsonStr = jsonStr.replace(/[\s]*```[\s\S]*$/i, '');
    jsonStr = jsonStr.trim();

    // Step2: { から最後の } を切り出す
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first !== -1 && last !== -1) {
      jsonStr = jsonStr.slice(first, last + 1);
    } else {
      console.error('No JSON object found. raw:', raw);
      return res.status(500).json({ error: 'Invalid JSON from AI', raw: raw });
    }

    // Step3: 途中切れチェック（{ と } の数が一致しない場合は不完全）
    const openBraces = (jsonStr.match(/\{/g) || []).length;
    const closeBraces = (jsonStr.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      console.error('Incomplete JSON. open:', openBraces, 'close:', closeBraces, 'raw:', raw);
      return res.status(500).json({ error: 'Invalid JSON from AI', raw: raw });
    }

    let workflow;
    try {
      workflow = JSON.parse(jsonStr);
    } catch (e) {
      console.error('JSON parse failed. raw:', raw);
      return res.status(500).json({ error: 'Invalid JSON from AI', raw: raw });
    }

    if (!workflow.name)        workflow.name        = title;
    if (!workflow.connections) workflow.connections = {};
    if (!workflow.settings)    workflow.settings    = { executionOrder: 'v1' };
    if (!Array.isArray(workflow.nodes)) workflow.nodes = [];

    return res.status(200).json(workflow);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
