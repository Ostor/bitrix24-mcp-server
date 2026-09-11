import express from "express";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { AsyncLocalStorage } from "async_hooks";
import oauthRouter from "./oauth.js";
import { bitrix24, PORTAL_URL } from "./bitrix24.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import swaggerUi from "swagger-ui-express";
import basicAuth from "express-basic-auth";

import multer from "multer";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicPath = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '../src/public');
app.use(express.static(publicPath));

const upload = multer({ storage: multer.memoryStorage() });

const uploadTokens = new Map<string, { token: string, expires: number }>();

app.post('/api/import-kb', upload.array('files'), async (req: any, res: any) => {
  try {
    const uploadId = req.body.upload_id;
    if (!uploadId) return res.status(401).json({ error: "Missing upload_id. Please request a new upload link from the assistant." });
    
    const session = uploadTokens.get(uploadId);
    if (!session || Date.now() > session.expires) {
      return res.status(401).json({ error: "Upload link expired or invalid. Please ask the assistant to generate a new one." });
    }
    const token = session.token;

    const files = req.files as Express.Multer.File[];
    const mode = req.body.mode;
    
    let mdFile = files.find(f => f.originalname.endsWith('.md'));
    if (!mdFile) return res.status(400).json({ error: "No markdown file provided" });
    
    let markdown = mdFile.buffer.toString('utf8').normalize('NFC');
    const images = files.filter(f => !f.originalname.endsWith('.md')).map(img => {
      // Fix multer latin1 filename encoding issue and normalize macOS NFD to standard NFC
      const correctName = Buffer.from(img.originalname, 'latin1').toString('utf8').normalize('NFC');
      return {
        name: correctName,
        base64: img.buffer.toString('base64')
      };
    });

    let result;
    if (mode === 'create') {
      let kbId = String(req.body.kbId);
      const kbMatch = kbId.match(/workspace\/(\d+)/) || kbId.match(/collection\/(\d+)/);
      if (kbMatch) kbId = kbMatch[1];
      else kbId = kbId.replace(/\D/g, '');

      const correctMdName = Buffer.from(mdFile.originalname, 'latin1').toString('utf8').normalize('NFC');
      const title = req.body.title || correctMdName.replace('.md', '');
      result = await bitrix24.addKnowledgeBasePage(token, kbId, title, markdown, undefined, images);
    } else {
      let pageId = String(req.body.pageId);
      const pMatch = pageId.match(/page\/(\d+)/) || pageId.match(/document\/(\d+)/);
      if (pMatch) pageId = pMatch[1];
      else pageId = pageId.replace(/\D/g, '');

      result = await bitrix24.updateKnowledgeBasePage(token, pageId, undefined, markdown, images);
    }

    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

const swaggerV5Path = fs.existsSync(path.join(__dirname, 'swagger-v5.json'))
  ? path.join(__dirname, 'swagger-v5.json')
  : path.join(__dirname, '../src/swagger-v5.json');
const swaggerV6Path = fs.existsSync(path.join(__dirname, 'swagger-v6.json'))
  ? path.join(__dirname, 'swagger-v6.json')
  : path.join(__dirname, '../src/swagger-v6.json');

// --- Basic Auth middleware для Swagger ---
const swaggerAuth = basicAuth({
  users: { 'ithelper': 'ithelper2027!' },
  challenge: true,
  realm: 'Swagger Documentation'
});

app.get('/gpt/swagger/v5.json', swaggerAuth, (req, res) => res.sendFile(swaggerV5Path));
app.get('/gpt/swagger/v6.json', swaggerAuth, (req, res) => res.sendFile(swaggerV6Path));

const swaggerOptions = {
  explorer: true,
  swaggerOptions: {
    urls: [
      { url: '/gpt/swagger/v6.json', name: 'V6' },
      { url: '/gpt/swagger/v5.json', name: 'V5' }
    ]
  }
};
app.use('/gpt/swagger', swaggerAuth, swaggerUi.serve, swaggerUi.setup(undefined, swaggerOptions));

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

  // 1.5. Поиск сотрудников (Пользователей)
  server.tool(
    "bitrix24_search_users",
    "Найти сотрудников компании (teammates/users). Возвращает список пользователей.",
    {
      name: z.string().optional().describe("Имя или фамилия сотрудника для поиска"),
      email: z.string().optional().describe("Email сотрудника для поиска")
    },
    async ({ name, email }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.searchUsers(token, name, email);
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

  // 19.5 Поиск страниц по всем Базам Знаний (аналог старого kb2_search_documents)
  server.tool(
    "bitrix24_search_kb_pages",
    "Найти страницы в Базах Знаний (KB 2.0) по ключевому слову в заголовке",
    {
      query: z.string().describe("Ключевое слово для поиска в заголовках страниц")
    },
    async ({ query }) => {
      const token = getTokenOrThrow();
      const kbs = await bitrix24.listKnowledgeBases(token);
      let results = [];
      const lowerQuery = query.toLowerCase();
      
      for (const kb of kbs) {
        if (!kb.id) continue;
        const pages = await bitrix24.listKnowledgeBasePages(token, kb.id);
        for (const page of pages) {
          if (page.title && page.title.toLowerCase().includes(lowerQuery)) {
            results.push({
              kbId: kb.id,
              kbName: kb.title,
              pageId: page.id,
              pageTitle: page.title,
              parentId: page.parentId
            });
          }
        }
      }
      
      return {
        content: [{ type: "text", text: results.length > 0 ? JSON.stringify(results, null, 2) : "Ничего не найдено по данному запросу." }]
      };
    }
  );

  // 19.6 Генерация ссылки для веб-интерфейса массовой загрузки
  server.tool(
    "bitrix24_get_upload_link",
    "Сгенерировать магическую ссылку на веб-интерфейс, через которую пользователь сможет сам загрузить .md файл и картинки. Используй это, когда пользователь хочет обновить страницу с картинками.",
    {},
    async () => {
      const token = getTokenOrThrow();
      const uploadId = crypto.randomUUID();
      // Храним токен 1 час (3600000 мс)
      uploadTokens.set(uploadId, { token, expires: Date.now() + 3600000 });
      const link = `https://mcp.ai-helperbot.online/index.html?upload_id=${uploadId}`;
      return {
        content: [{ type: "text", text: `Отправьте пользователю эту ссылку для загрузки файлов (она активна 1 час):\n\n${link}` }]
      };
    }
  );

  // 20. CRM Invoices (Old Module)
  server.tool(
    "bitrix24_crm_invoice_list",
    "Получить список старых счетов",
    {
      select: z.array(z.string()).optional().describe("Список запрашиваемых полей"),
      filter: z.record(z.any()).optional().describe("Фильтр для поиска"),
      order: z.record(z.any()).optional().describe("Сортировка"),
      start: z.number().optional().describe("Отступ для пагинации")
    },
    async ({ select, filter, order, start }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listCrmInvoices(token, select, filter, order, start);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_invoice_get",
    "Получить старый счет по ID",
    { id: z.number().describe("ID счета") },
    async ({ id }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getCrmInvoice(token, id);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_invoice_add",
    "Создать старый счет",
    { fields: z.record(z.any()).describe("Поля счета") },
    async ({ fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.addCrmInvoice(token, fields);
      return {
        content: [{ type: "text", text: `Invoice created: ${JSON.stringify(result)}` }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_invoice_update",
    "Обновить старый счет",
    {
      id: z.number().describe("ID счета"),
      fields: z.record(z.any()).describe("Поля")
    },
    async ({ id, fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateCrmInvoice(token, id, fields);
      return {
        content: [{ type: "text", text: `Invoice updated: ${JSON.stringify(result)}` }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_invoice_delete",
    "Удалить старый счет",
    { id: z.number().describe("ID счета") },
    async ({ id }) => {
      const token = getTokenOrThrow();
      await bitrix24.deleteCrmInvoice(token, id);
      return {
        content: [{ type: "text", text: `Invoice deleted` }]
      };
    }
  );

  // 21. CRM Smart Processes (Items)
  server.tool(
    "bitrix24_crm_item_fields",
    "Получить структуру полей для конкретного смарт-процесса (например, для счетов, заявок и т.д.)",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса (например, 31 для счетов)")
    },
    async ({ entityTypeId }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getCrmItemFields(token, entityTypeId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_item_list",
    "Получить список элементов смарт-процесса (счетов, заявок и т.д.)",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса"),
      select: z.array(z.string()).optional().describe("Список запрашиваемых полей"),
      filter: z.record(z.any()).optional().describe("Фильтр для поиска"),
      order: z.record(z.any()).optional().describe("Сортировка"),
      start: z.number().optional().describe("Отступ для пагинации")
    },
    async ({ entityTypeId, select, filter, order, start }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.listCrmItems(token, entityTypeId, select, filter, order, start);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_item_get",
    "Получить конкретный элемент смарт-процесса по его ID",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса"),
      id: z.number().describe("ID элемента")
    },
    async ({ entityTypeId, id }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.getCrmItem(token, entityTypeId, id);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_item_add",
    "Создать новый элемент смарт-процесса (например, выставить счет)",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса"),
      fields: z.record(z.any()).describe("Поля нового элемента")
    },
    async ({ entityTypeId, fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.addCrmItem(token, entityTypeId, fields);
      return {
        content: [{ type: "text", text: `Item successfully created in entity ${entityTypeId}. Details: ${JSON.stringify(result)}` }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_item_update",
    "Обновить элемент смарт-процесса (например, сменить статус счета)",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса"),
      id: z.number().describe("ID элемента"),
      fields: z.record(z.any()).describe("Поля для обновления")
    },
    async ({ entityTypeId, id, fields }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateCrmItem(token, entityTypeId, id, fields);
      return {
        content: [{ type: "text", text: `Item ${id} successfully updated. Details: ${JSON.stringify(result)}` }]
      };
    }
  );

  server.tool(
    "bitrix24_crm_item_delete",
    "Удалить элемент смарт-процесса",
    {
      entityTypeId: z.number().describe("ID типа смарт-процесса"),
      id: z.number().describe("ID элемента")
    },
    async ({ entityTypeId, id }) => {
      const token = getTokenOrThrow();
      await bitrix24.deleteCrmItem(token, entityTypeId, id);
      return {
        content: [{ type: "text", text: `Item ${id} successfully deleted.` }]
      };
    }
  );

  // 21. Создание новой страницы в Базе знаний
  server.tool(
    "bitrix24_add_kb_page",
    "Создать новую страницу в Базе знаний 2.0 с Markdown содержимым",
    {
      kbId: z.string().describe("ID Базы знаний (collectionId)"),
      title: z.string().describe("Заголовок новой страницы"),
      markdown: z.string().describe("Содержимое страницы в формате Markdown"),
      parentId: z.string().optional().describe("ID родительской страницы (если нужно создать подстраницу)"),
      images: z.array(z.object({
        name: z.string().describe("Имя файла или путь, как он указан в markdown (например, image.png)"),
        base64: z.string().describe("Base64 строка содержимого картинки")
      })).optional().describe("Массив картинок для загрузки. MCP сервер сам загрузит их в Битрикс24 и заменит пути в markdown.")
    },
    async ({ kbId, title, markdown, parentId, images }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.addKnowledgeBasePage(token, kbId, title, markdown, parentId, images);
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
      markdown: z.string().optional().describe("Новое содержимое страницы в формате Markdown (полностью перезапишет старое)"),
      images: z.array(z.object({
        name: z.string().describe("Имя файла или путь, как он указан в markdown (например, image.png)"),
        base64: z.string().describe("Base64 строка содержимого картинки")
      })).optional().describe("Массив картинок для загрузки. MCP сервер сам загрузит их в Битрикс24 и заменит пути в markdown.")
    },
    async ({ pageId, title, markdown, images }) => {
      const token = getTokenOrThrow();
      const result = await bitrix24.updateKnowledgeBasePage(token, pageId, title, markdown, images);
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
