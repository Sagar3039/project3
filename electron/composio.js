const USER_ID = 'pg-test-ecad251a-3da8-462b-a086-46806af14cb4';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || 'ak_hrquWJrykbmcz-3ch_hM';

let composioInstance = null;
let sessionInstance = null;
let ComposioClass = null;
let cachedTools = null;

async function loadModule() {
  if (!ComposioClass) {
    const mod = await import('@composio/core');
    ComposioClass = mod.Composio;
  }
  return ComposioClass;
}

async function getComposio() {
  if (!composioInstance) {
    const Composio = await loadModule();
    composioInstance = new Composio({ apiKey: COMPOSIO_API_KEY });
  }
  return composioInstance;
}

async function getSession() {
  if (!sessionInstance) {
    const composio = await getComposio();
    sessionInstance = composio.createSession(USER_ID);
  }
  return sessionInstance;
}

/**
 * Get available tools, formatted for the system prompt.
 * @param {string[]} toolkits - optional toolkit filter e.g. ['github', 'gmail']
 */
const DEFAULT_TOOLKITS = ['github', 'gmail', 'todoist', 'googledrive', 'notion', 'googlecalendar'];

async function getToolsForPrompt(toolkits) {
  try {
    const session = await getSession();
    const kits = toolkits && toolkits.length > 0 ? toolkits : DEFAULT_TOOLKITS;

    // Fetch each toolkit separately to avoid API limit
    const allTools = [];
    for (const tk of kits) {
      try {
        const tools = await session.tools.getRawComposioTools({ toolkits: [tk] });
        for (const t of tools) {
          allTools.push({
            name: t.name || t.slug,
            slug: t.slug,
            description: t.description || '',
            inputSchema: t.inputParameters || t.inputSchema || {},
            toolkit: typeof t.toolkit === 'string' ? t.toolkit : (t.toolkit?.name || t.toolkit?.slug || tk),
            version: t.version || ''
          });
        }
      } catch {}
    }

    cachedTools = allTools;
    return allTools;
  } catch (e) {
    console.error('[Composio] Failed to get tools:', e.message);
    return [];
  }
}

/**
 * Build a tool description block for the system prompt.
 */
function buildToolPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  // Pick key tools: one per toolkit + important ones
  const keySlugs = [
    'GITHUB_CREATE_REPOSITORY', 'GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER',
    'GITHUB_CREATE_ISSUE', 'GITHUB_CREATE_PULL_REQUEST',
    'GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_FETCH_EMAILS', 'GMAIL_LIST_DRAFTS',
    'TODOIST_CREATE_TASK', 'TODOIST_DELETE_TASK', 'TODOIST_CLOSE_TASK',
    'GOOGLEDRIVE_CREATE_FILE_FROM_DATA', 'GOOGLEDRIVE_LIST_FILES',
    'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_LIST_EVENTS',
    'NOTION_CREATE_PAGE', 'NOTION_RETRIEVE_PAGE', 'NOTION_UPDATE_PAGE'
  ];

  const selected = [];
  const seen = new Set();
  for (const slug of keySlugs) {
    const t = tools.find(x => x.slug === slug);
    if (t && !seen.has(slug)) { selected.push(t); seen.add(slug); }
  }
  // Add any remaining tools up to 25
  for (const t of tools) {
    if (selected.length >= 25) break;
    if (!seen.has(t.slug)) { selected.push(t); seen.add(t.slug); }
  }

  const toolList = selected.map(t => {
    const params = Object.keys(t.inputSchema?.properties || {}).join(', ');
    return `- ${t.slug} (${t.toolkit}): ${t.description.substring(0, 100)}${params ? ` [params: ${params}]` : ''}`;
  }).join('\n');

  return `## Available External Tools (via Composio)
You have access to external tools. To use a tool, output EXACTLY this format on its own line:
[TOOL_CALL: TOOL_SLUG(param1: "value1", param2: "value2")]

IMPORTANT: You MUST use the exact TOOL_SLUG shown below (e.g. GMAIL_SEND_EMAIL, not "Send Email").
Available tools:
${toolList}

Rules:
- Only call tools when the user explicitly asks for an action that requires them.
- Tool calls must be on their own line, not inside other text.
- After a tool call, wait for the result before continuing.
- If a tool call fails, explain the error to the user.
- NEVER guess a tool slug. Only use the exact slugs listed above.`;
}

/**
 * Parse a tool call from AI output.
 * Format: [TOOL_CALL: TOOL_NAME(param1: "value1", param2: "value2")]
 */
function parseToolCall(text) {
  const match = text.match(/\[TOOL_CALL:\s*(\w+)\((.*?)\)\]/s);
  if (!match) return null;

  const toolName = match[1];
  const argsStr = match[2];

  const args = {};
  if (argsStr.trim()) {
    const regex = /(\w+)\s*:\s*"([^"]*)"/g;
    let m;
    while ((m = regex.exec(argsStr)) !== null) {
      args[m[1]] = m[2];
    }
  }

  return { toolName, args };
}

/**
 * Execute a tool call via Composio.
 */
async function executeTool(toolName, args) {
  let version = '';
  let toolkitName = '';

  try {
    // Ensure tools are cached to get the version
    if (!cachedTools || cachedTools.length === 0) {
      await getToolsForPrompt();
    }

    // Look up toolkit version and toolkit name from cached tools
    if (cachedTools) {
      const tool = cachedTools.find(t => t.slug === toolName);
      if (tool) {
        version = tool.version || '';
        toolkitName = tool.toolkit || '';
      }
    }

    // Use REST API directly
    const response = await fetch(`https://api.composio.dev/v3.1/tools/${toolName}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': COMPOSIO_API_KEY
      },
      body: JSON.stringify({
        arguments: args,
        version: version || undefined,
        user_id: USER_ID
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error?.message || result.message || 'Execution failed');
    }

    return { success: true, result };
  } catch (e) {
    console.error(`[Composio] Tool execution failed (${toolName}):`, e.message);

    // Provide helpful error message for auth issues
    const msg = e.message || '';
    if (msg.includes('connected account') || msg.includes('UNAUTHORIZED') || msg.includes('not found') || msg.includes('Error executing')) {
      return {
        success: false,
        error: `You need to connect your ${toolkitName || 'external'} account first. Go to https://app.composio.dev/dashboard to authorize ${toolkitName || 'this service'}.`
      };
    }
    return { success: false, error: msg };
  }
}

/**
 * Get connection status for a toolkit.
 */
async function getConnectionStatus(toolkit) {
  try {
    const session = await getSession();
    const connections = await session.connectedAccounts.get({ toolkit });
    return connections || [];
  } catch (e) {
    return [];
  }
}

/**
 * Get OAuth redirect URL for connecting a toolkit.
 */
async function getConnectUrl(toolkit) {
  try {
    const session = await getSession();
    const url = await session.toolkits.authorize({
      toolkit,
      redirectUrl: 'http://localhost:5173/composio/callback'
    });
    return url;
  } catch (e) {
    console.error('[Composio] Failed to get connect URL:', e.message);
    return null;
  }
}

module.exports = {
  getToolsForPrompt,
  buildToolPrompt,
  parseToolCall,
  executeTool,
  getConnectionStatus,
  getConnectUrl,
  USER_ID
};
