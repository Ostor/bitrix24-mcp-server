import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { AsyncLocalStorage } from "async_hooks";
import oauthRouter from "./oauth.js";
import { bitrix24, PORTAL_URL } from "./bitrix24.js";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- НАСТРОЙКА CORS MIDDLEWARE ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Контекст для проброса токена текущего пользователя
export const authContext = new AsyncLocalStorage<{ token: string }>();
const sessionTokens = new Map<string, string>();

/**
 * Вспомогательная функция для получения токена текущего пользователя.
 * Выбрасывает ошибку, если пользователь не авторизован в Claude.
 */
function getTokenOrThrow(): string {
  const store = authContext.getStore();
  if (!store || !store.token) {
    throw new Error("Unauthorized: Access token is missing or invalid. Please sign in to your Bitrix24.");
  }
  return store.token;
}

// Подключаем эндпоинты OAuth
app.use("/", oauthRouter);

/**
 * Создает и настраивает новый экземпляр MCP сервера для каждого подключения.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "bitrix24-mcp-server",
    version: "1.0.0"
  });

  // 1. Получение информации о пользователе
  server.tool(
    "bitrix24_get_user_info",
    "Получить информацию о текущем авторизованном пользователе Битрикс24",
    {},
    async () => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getCurrentUser(token);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 2. Список сделок
  server.tool(
    "bitrix24_list_deals",
    "Получить список сделок CRM Битрикс24 по фильтру",
    {
      filter: z.record(z.any()).optional().describe("Фильтр для выбора сделок (например: {'STAGE_ID': 'NEW'})"),
      select: z.array(z.string()).optional().describe("Массив полей для выбора (например: ['ID', 'TITLE', 'OPPORTUNITY'])")
    },
    async ({ filter, select }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listDeals(token, filter, select);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 3. Детали сделки
  server.tool(
    "bitrix24_get_deal",
    "Получить детальную информацию о конкретной сделке по ID",
    {
      id: z.string().describe("Идентификатор сделки в Битрикс24")
    },
    async ({ id }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getDeal(token, id);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 4. Создание сделки
  server.tool(
    "bitrix24_create_deal",
    "Создать новую сделку в CRM Битрикс24",
    {
      fields: z.record(z.any()).describe("Поля новой сделки (обязательно передавать 'TITLE')")
    },
    async ({ fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.createDeal(token, fields);
      return {
        content: [{ type: "text", text: `Deal successfully created with ID: ${result}` }]
      };
    }
  );

  // 5. Обновление сделки
  server.tool(
    "bitrix24_update_deal",
    "Обновить существующую сделку в CRM Битрикс24",
    {
      id: z.string().describe("ID сделки, которую нужно обновить"),
      fields: z.record(z.any()).describe("Обновляемые поля сделки")
    },
    async ({ id, fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateDeal(token, id, fields);
      return {
        content: [{ type: "text", text: result ? `Deal ${id} successfully updated.` : `Failed to update deal ${id}.` }]
      };
    }
  );

  // 6. Список контактов
  server.tool(
    "bitrix24_list_contacts",
    "Получить список контактов CRM Битрикс24 по фильтру",
    {
      filter: z.record(z.any()).optional().describe("Фильтр для контактов"),
      select: z.array(z.string()).optional().describe("Выбираемые поля контакта")
    },
    async ({ filter, select }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listContacts(token, filter, select);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 7. Создание контакта
  server.tool(
    "bitrix24_create_contact",
    "Создать новый контакт в CRM Битрикс24",
    {
      fields: z.record(z.any()).describe("Поля контакта (например, {'NAME': 'Имя', 'LAST_NAME': 'Фамилия'})")
    },
    async ({ fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.createContact(token, fields);
      return {
        content: [{ type: "text", text: `Contact successfully created with ID: ${result}` }]
      };
    }
  );

  // 8. Список задач
  server.tool(
    "bitrix24_list_tasks",
    "Получить список задач Битрикс24",
    {
      filter: z.record(z.any()).optional().describe("Фильтр для выбора задач (например: {'RESPONSIBLE_ID': 1})"),
      select: z.array(z.string()).optional().describe("Выбираемые поля задач")
    },
    async ({ filter, select }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listTasks(token, filter, select);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 9. Детали задачи
  server.tool(
    "bitrix24_get_task",
    "Получить подробную информацию о задаче по ID",
    {
      id: z.string().describe("ID задачи в Битрикс24")
    },
    async ({ id }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getTask(token, id);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 10. Создание задачи
  server.tool(
    "bitrix24_create_task",
    "Создать новую задачу в Битрикс24",
    {
      fields: z.record(z.any()).describe("Поля новой задачи (обязательно передавать 'TITLE' и 'RESPONSIBLE_ID'. Для привязки задачи к скрам-доске/проекту передайте 'GROUP_ID' с ID этой доски)")
    },
    async ({ fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.createTask(token, fields);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 11. Обновление задачи
  server.tool(
    "bitrix24_update_task",
    "Обновить параметры существующей задачи",
    {
      id: z.string().describe("ID обновляемой задачи"),
      fields: z.record(z.any()).describe("Поля для обновления (для переноса задачи на другую скрам-доску/проект передайте 'GROUP_ID' с новым ID)")
    },
    async ({ id, fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateTask(token, id, fields);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 12. Получение списка скрам-досок (Scrum boards)
  server.tool(
    "bitrix24_list_scrum_boards",
    "Получить список только Scrum-досок (скрам-досок задач) в Битрикс24",
    {
      filter: z.record(z.any()).optional().describe("Дополнительный фильтр для досок")
    },
    async ({ filter }) => {
      const token = getTokenOrThrow();
      const actualFilter = { 
        ...(filter || {}),
        type: "scrum" // Всегда запрашиваем только Scrum-доски
      };
      const result = await bitrix24.listWorkgroups(token, actualFilter);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 13. Получение списка спринтов Scrum-доски
  server.tool(
    "bitrix24_list_scrum_sprints",
    "Получить список спринтов Scrum-доски (группы/проекта) с их статусами и датами",
    {
      groupId: z.string().describe("ID Scrum-доски (группы/проекта)")
    },
    async ({ groupId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listScrumSprints(token, groupId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 14. Получение списка комментариев к задаче
  server.tool(
    "bitrix24_list_task_comments",
    "Получить список комментариев к конкретной задаче в Битрикс24",
    {
      taskId: z.string().describe("ID задачи")
    },
    async ({ taskId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listTaskComments(token, taskId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 15. Сводный инструмент для получения всех задач спринта с комментариями и ссылками
  server.tool(
    "bitrix24_get_sprint_tasks_comments",
    "Получить сводный отчет по всем задачам определенного спринта (включая ссылки на них) и их комментариям",
    {
      groupId: z.string().describe("ID Scrum-доски"),
      sprintId: z.string().describe("ID спринта")
    },
    async ({ groupId, sprintId }) => {
      const token = getTokenOrThrow();
      
      // 1. Получаем задачи напрямую по фильтру SPRINT_ID
      const sprintTasks = await bitrix24.listTasks(token, { SPRINT_ID: Number(sprintId) });
      
      if (sprintTasks.length === 0) {
        return {
          content: [{ type: "text", text: `Задач в спринте с ID ${sprintId} не найдено.` }]
        };
      }
      
      // 3. Получаем комментарии для каждой задачи параллельно
      const tasksWithComments = await Promise.all(
        sprintTasks.map(async (task) => {
          const comments = await bitrix24.listTaskComments(token, task.id);
          const taskUrl = `${PORTAL_URL.replace(/\/$/, "")}/company/personal/user/0/tasks/task/view/${task.id}/`;
          
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            url: taskUrl,
            comments: comments.map((c: any) => ({
              id: c.ID,
              author: c.AUTHOR_NAME,
              date: c.POST_DATE,
              text: c.POST_MESSAGE_HTML || c.POST_MESSAGE
            }))
          };
        })
      );
      
      return {
        content: [{ type: "text", text: JSON.stringify(tasksWithComments, null, 2) }]
      };
    }
  );

  // 16. Добавление комментария к задаче
  server.tool(
    "bitrix24_add_task_comment",
    "Добавить комментарий к задаче. Можно прикрепить файлы (например скриншоты), передав их в base64.",
    {
      taskId: z.string().describe("ID задачи"),
      text: z.string().describe("Текст комментария"),
      files: z.array(
        z.object({
          name: z.string().describe("Имя файла с расширением (например screenshot.png)"),
          contentBase64: z.string().describe("Содержимое файла в формате base64")
        })
      ).optional().describe("Массив прикрепляемых файлов (опционально)")
    },
    async ({ taskId, text, files }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.addTaskComment(token, taskId, text, files);
      return {
        content: [{ type: "text", text: `Comment successfully added to task ${taskId}. Comment ID: ${result}` }]
      };
    }
  );

  // 17. Список Баз знаний 2.0
  server.tool(
    "bitrix24_list_knowledge_bases",
    "Получить список всех Баз знаний (Knowledge Bases 2.0 / note). Используй этот инструмент, если пользователь дает ссылки вида /note/workspace/...",
    {},
    async () => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listKnowledgeBases(token);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 18. Дерево страниц Базы знаний
  server.tool(
    "bitrix24_list_kb_pages",
    "Получить дерево страниц внутри конкретной Базы знаний 2.0. Если пользователь дал ссылку /note/workspace/X/, то X — это kbId.",
    {
      kbId: z.string().describe("ID Базы знаний (collectionId)")
    },
    async ({ kbId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listKnowledgeBasePages(token, kbId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 19. Получение Markdown содержимого страницы
  server.tool(
    "bitrix24_get_kb_page",
    "Получить информацию о странице и её Markdown-содержимое. В ссылках вида /note/workspace/X/page/Y/ id страницы — это Y.",
    {
      pageId: z.string().describe("ID страницы (id)")
    },
    async ({ pageId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getKnowledgeBasePage(token, pageId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // 20. Создание новой страницы в Базе знаний
  server.tool(
    "bitrix24_add_kb_page",
    "Создать новую страницу в Базе знаний 2.0 с Markdown содержимым",
    {
      kbId: z.string().describe("ID Базы знаний (collectionId)"),
      title: z.string().describe("Заголовок новой страницы"),
      markdown: z.string().describe("Содержимое страницы в формате Markdown"),
      parentId: z.string().optional().describe("ID родительской страницы (если нужно создать подстраницу)")
    },
    async ({ kbId, title, markdown, parentId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.addKnowledgeBasePage(token, kbId, title, markdown, parentId);
      return {
        content: [{ type: "text", text: `Page successfully created in Knowledge Base ${kbId}. Details: ${JSON.stringify(result)}` }]
      };
    }
  );

  // 21. Обновление страницы
  server.tool(
    "bitrix24_update_kb_page",
    "Обновить заголовок или Markdown содержимое существующей страницы Базы знаний",
    {
      pageId: z.string().describe("ID страницы (id)"),
      title: z.string().optional().describe("Новый заголовок страницы"),
      markdown: z.string().optional().describe("Новое содержимое страницы в формате Markdown (полностью перезапишет старое)")
    },
    async ({ pageId, title, markdown }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateKnowledgeBasePage(token, pageId, title, markdown);
      return {
        content: [{ type: "text", text: `Page ${pageId} successfully updated. Details: ${JSON.stringify(result)}` }]
      };
    }
  );

  return server;
}

// --- НАСТРОЙКА SSE ТРАНСПОРТА И MIDDLEWARE ---

const transports = new Map<string, SSEServerTransport>();
const SERVER_PUBLIC_URL = (process.env.SERVER_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * Middleware для извлечения OAuth токена и проброса его в контекст AsyncLocalStorage.
 */
const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  let token = "";
  
  // 1. Ищем токен в заголовке Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }
  
  // 2. Ищем токен в query параметрах (проверяем ?token=... и стандартный ?access_token=...)
  if (!token) {
    token = (req.query.token || req.query.access_token) as string || "";
  }
  
  // 3. Если это POST-сообщение без заголовка, ищем сохраненный токен по sessionId
  const sessionId = req.query.sessionId as string;
  if (!token && sessionId) {
    token = sessionTokens.get(sessionId) || "";
  }
  
  // Сохраняем/обновляем токен для сессии, если он найден
  if (token && sessionId) {
    sessionTokens.set(sessionId, token);
  }
  
  if (token) {
    try {
      fs.writeFileSync("/root/bitrix24-mcp-server/active_token.txt", token);
    } catch (err) {
      console.error("[Bitrix24] Failed to write active_token.txt:", err);
    }
  }
  
  if (token) {
    authContext.run({ token }, () => {
      next();
    });
  } else {
    next();
  }
};

// Маршрут для открытия постоянного SSE-канала (GET /sse)
app.get("/sse", authMiddleware, async (req, res) => {
  const token = authContext.getStore()?.token;
  console.log(`[SSE] Requesting new connection... Token: ${token ? "present" : "absent"}`);
  
  // Перехватываем res.write для журналирования отправляемых SSE данных
  const originalWrite = res.write.bind(res);
  res.write = function (chunk: any, encoding?: any, cb?: any) {
    console.log(`[SSE WRITE] Session data written:\n${chunk ? chunk.toString() : ""}`);
    return originalWrite(chunk, encoding, cb);
  };
  
  // Инициализируем SSE-транспорт
  const transport = new SSEServerTransport(`${SERVER_PUBLIC_URL}/messages`, res);
  
  // Сохраняем транспорт по sessionId и по токену пользователя (если он передан)
  transports.set(transport.sessionId, transport);
  if (token) {
    console.log(`[SSE] Mapping connection to Bearer token: ${token.substring(0, 10)}...`);
    transports.set(token, transport);
  }
  
  res.on("close", () => {
    console.log(`[SSE] Connection closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
    if (token) {
      transports.delete(token);
    }
    sessionTokens.delete(transport.sessionId);
  });
  
  // Создаем новый независимый экземпляр сервера для данного подключения
  const connectionServer = createMcpServer();
  await connectionServer.connect(transport);
  console.log(`[SSE] Client successfully connected. Session: ${transport.sessionId}`);
});

// Маршрут для входящих JSON-RPC сообщений от клиента
const handlePostMessage = async (req: express.Request, res: express.Response) => {
  const sessionId = req.query.sessionId as string;
  const token = authContext.getStore()?.token;
  
  console.log(`[SSE] POST message received. SessionId in query: ${sessionId || "none"}. Token: ${token ? "present" : "absent"}`);
  
  let transport: SSEServerTransport | undefined;
  if (sessionId) {
    transport = transports.get(sessionId);
  }
  if (!transport && token) {
    console.log(`[SSE] Looking up transport by Bearer token: ${token.substring(0, 10)}...`);
    transport = transports.get(token);
  }
  
  if (transport) {
    try {
      console.log(`[SSE] Routing message to transport.handlePostMessage (Session: ${transport.sessionId})...`);
      await transport.handlePostMessage(req, res, req.body);
      console.log(`[SSE] transport.handlePostMessage completed successfully.`);
    } catch (error: any) {
      console.error(`[SSE] Error during transport.handlePostMessage (Session: ${transport.sessionId}):`, error?.stack || error?.message || error);
      res.status(500).send(`Internal error handling message: ${error.message}`);
    }
  } else {
    console.warn(`[SSE] Post message received, but no active transport found. SessionId: ${sessionId || "none"}, Token: ${token ? "present" : "absent"}`);
    res.status(400).send("No active transport found for this session or token.");
  }
};

// Регистрируем обработчик для POST /messages и для POST /sse (для клиентов, которые шлют POST туда же)
app.post("/messages", authMiddleware, handlePostMessage);
app.post("/sse", authMiddleware, handlePostMessage);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Bitrix24 MCP Server running on port ${PORT}`);
  console.log(`🔗 Local Base URL: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
