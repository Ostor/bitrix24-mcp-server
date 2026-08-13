# Bitrix24 MCP Server

[🇬🇧 English](README.md) | [🇷🇺 Русская версия](README.ru.md)

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

This project is a **Model Context Protocol (MCP) server** for integrating AI assistants (like Anthropic's Claude) with your **Bitrix24** portal. The server enables Large Language Models to directly retrieve data, manage CRM entities, tasks, and knowledge bases through a standardized API.

## Features (Tools)

The server provides AI with the following tools:
- **CRM:** Deals (read, list), Contacts (read, list).
- **Tasks:** Read tasks, list, create, update, close, add comments.
- **Scrum:** View epics and bind tasks to epics.
- **Knowledge Base (2.0):** Read knowledge bases, view structure, create, edit, and retrieve pages in Markdown format.
- **Company Structure:** Retrieve information about the current user.

## Requirements

- Node.js >= 22 (or Docker)
- Administrator rights in your Bitrix24 portal (to create the integration)
- Anthropic Claude Desktop (or another MCP-compatible client)

## Installation and Setup

### Step 1. Create a Local Application in Bitrix24

For the server to communicate with your portal, you need to create an integration.
1. In the left menu of Bitrix24, go to **Applications** -> **Developer resources** -> **Other** -> **Local application**.
2. Check the "Uses API" box.
3. **Mandatory: Add the following permissions (scopes):**
   - `crm` (CRM)
   - `task` (Tasks)
   - `tasks_extended` (Extended Tasks)
   - `note` (Knowledge Base 2.0)
   - `user` (Users)
4. For the **Initial installation path** and **Webhook URL**, you can specify your future server domain or simply `https://localhost:3000`.
5. Save the application and write down the **Application Code (Client ID)** and **Application Key (Client Secret)**.

### Step 2. Server Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/bitrix24-mcp-server.git
cd bitrix24-mcp-server
npm install
```

Create a `.env` file in the project root (or copy `.env.example`) and fill in the details:

```env
PORT=3000
BITRIX24_CLIENT_ID=your_client_id
BITRIX24_CLIENT_SECRET=your_client_secret
BITRIX24_PORTAL_URL=https://yourcompany.bitrix24.com
```

### Step 3. Running the Server

You can run the server in two ways:

**Option A: Using Node.js**
```bash
npm run build
npm start
```
For background execution on a server, we recommend using `pm2`:
```bash
pm2 start dist/index.js --name bitrix24-mcp-server
```

**Option B: Using Docker**
```bash
docker-compose up -d
```

The server will start on port `3000` and will be ready to accept SSE connections.

### Step 4. Configuring Claude Desktop (Client)

If you are running this server remotely (e.g., on a VPS) and want to connect it to your local Claude Desktop app, you will need to forward the port or set up an Nginx Reverse Proxy.

In your Claude configuration file (`claude_desktop_config.json` on MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), add the following:

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/inspector",
        "http://your-server-address:3000/sse"
      ]
    }
  }
}
```
*Note: This example uses the built-in inspector if you want to connect via HTTP SSE. If running the server locally, you can use `command: "node", args: ["/path/to/bitrix24-mcp-server/dist/index.js"]` (if the server supports stdio transport).*

## License

MIT
