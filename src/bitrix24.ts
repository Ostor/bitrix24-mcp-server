import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export const PORTAL_URL = process.env.BITRIX24_PORTAL_URL || "https://yourcompany.bitrix24.com";

export interface Bitrix24Response<T> {
  result: T;
  next?: number;
  total?: number;
  error?: string;
  error_description?: string;
}

/**
 * Вызов метода REST API Битрикс24
 */
export async function callBitrix24<T>(
  method: string,
  params: any,
  token: string
): Promise<T> {
  const isRest3 = method.startsWith("note.");
  const url = isRest3 
    ? `${PORTAL_URL.replace(/\/$/, "")}/rest/api/${method}`
    : `${PORTAL_URL.replace(/\/$/, "")}/rest/${method}.json`;
  
  try {
    const response = await axios.post<Bitrix24Response<T>>(
      url,
      {
        ...params,
        auth: token,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.error) {
      if (typeof response.data.error === "object" && response.data.error !== null) {
        const errObj = response.data.error as any;
        throw new Error(`Bitrix24 REST 3.0 Error (${errObj.code}): ${errObj.message}`);
      } else {
        throw new Error(
          `Bitrix24 Error (${response.data.error}): ${response.data.error_description || "Unknown error"}`
        );
      }
    }

    return response.data.result;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response?.data) {
      console.error("[Bitrix24 API Error Data]:", JSON.stringify(error.response.data, null, 2));
      const data = error.response.data as any;
      
      let errMsg = error.message;
      if (data.error) {
        if (typeof data.error === "object" && data.error !== null) {
          errMsg = `(${data.error.code}): ${data.error.message}`;
        } else {
          errMsg = data.error_description || data.error;
        }
      } else {
        errMsg = JSON.stringify(data);
      }
      
      throw new Error(`Bitrix24 API failed: ${errMsg}`);
    }
    console.error("[Bitrix24 Unknown Error]:", error);
    throw error;
  }
}

// Вспомогательные функции для маппинга полей и кэширования метаданных
const fieldsMetaCache = new Map<string, { data: Record<string, { title?: string }>, timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

async function getFieldsMetadataCached(token: string, entityType: "deal" | "contact"): Promise<Record<string, { title?: string }>> {
  const cacheKey = `${token}_${entityType}`;
  const cached = fieldsMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const fieldsMethod = entityType === "deal" ? "crm.deal.fields" : "crm.contact.fields";
    const userfieldsMethod = entityType === "deal" ? "crm.deal.userfield.list" : "crm.contact.userfield.list";
    
    const [fieldsRes, userfieldsRes] = await Promise.all([
      callBitrix24<Record<string, { title?: string }>>(fieldsMethod, {}, token),
      callBitrix24<any[]>(userfieldsMethod, { filter: {}, order: { SORT: "ASC" }, LANG: "ru" }, token).catch(() => [])
    ]);
    
    const merged: Record<string, { title?: string }> = { ...fieldsRes };
    
    console.log(`[Bitrix24] Fetched ${userfieldsRes?.length || 0} userfields for ${entityType}`);
    if (Array.isArray(userfieldsRes) && userfieldsRes.length > 0) {
      console.log(`[Bitrix24] Sample userfield 0: ${JSON.stringify(userfieldsRes[0])}`);
      const target = userfieldsRes.find((f: any) => JSON.stringify(f).includes("Назначение") || JSON.stringify(f).includes("СИ"));
      if (target) {
        console.log(`[Bitrix24] Found target userfield: ${JSON.stringify(target)}`);
      } else {
        console.log(`[Bitrix24] No target userfield found containing "Назначение" or "СИ" among ${userfieldsRes.length} fields`);
      }
    }
    
    // Dump userfields to file for local inspection
    import("fs").then(fs => {
      fs.writeFileSync("/root/bitrix24-mcp-server/uf_dump.json", JSON.stringify(userfieldsRes, null, 2));
    }).catch(() => {});
    
    if (Array.isArray(userfieldsRes)) {
      for (const uf of userfieldsRes) {
        if (uf) {
          const fieldName = uf.FIELD_NAME || uf.fieldName || uf.field_name || "";
          if (fieldName) {
            let title = "";
            const rawEditLabel = uf.EDIT_FORM_LABEL || uf.editFormLabel || uf.edit_form_label;
            const rawColLabel = uf.LIST_COLUMN_LABEL || uf.listColumnLabel || uf.list_column_label;
            const rawFilterLabel = uf.LIST_FILTER_LABEL || uf.listFilterLabel || uf.list_filter_label;
            
            const rawLabel = rawEditLabel || rawColLabel || rawFilterLabel;
            
            if (rawLabel) {
              if (typeof rawLabel === "string") {
                title = rawLabel;
              } else if (typeof rawLabel === "object") {
                title = rawLabel.ru || rawLabel.en || Object.values(rawLabel)[0] as string || "";
              }
            }
            
            if (title) {
              merged[fieldName] = { title };
            }
          }
        }
      }
    }
    
    // Fallback: Enrich using the pre-generated static mapping file on VPS (especially for deals)
    if (entityType === "deal") {
      try {
        const fs = await import("fs");
        if (fs.existsSync("/root/bitrix24-mcp-server/uf_labels.json")) {
          const localLabels = JSON.parse(fs.readFileSync("/root/bitrix24-mcp-server/uf_labels.json", "utf8"));
          for (const key of Object.keys(localLabels)) {
            if (!merged[key] || merged[key].title === key) {
              merged[key] = { title: localLabels[key] };
            }
          }
        }
      } catch (err) {
        console.warn("[Bitrix24] Failed to merge local uf_labels.json:", err);
      }
    }
    
    fieldsMetaCache.set(cacheKey, { data: merged, timestamp: Date.now() });
    return merged;
  } catch (err) {
    console.warn(`[Bitrix24] Failed to fetch fields metadata for ${entityType}:`, err);
    return {};
  }
}

function mapObjectFields(obj: any, fieldsMeta: Record<string, { title?: string }>): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => mapObjectFields(item, fieldsMeta));
  }
  
  const mapped: any = {};
  for (const key of Object.keys(obj)) {
    const meta = fieldsMeta[key];
    if (meta && meta.title) {
      mapped[`${key} (${meta.title})`] = obj[key];
    } else {
      mapped[key] = obj[key];
    }
  }
  return mapped;
}

function cleanFields(fields: any): any {
  if (!fields || typeof fields !== "object") return fields;
  const cleaned: any = {};
  for (const key of Object.keys(fields)) {
    const cleanKey = key.split(" ")[0];
    cleaned[cleanKey] = fields[key];
  }
  return cleaned;
}

// Вспомогательные типы и функции для конкретных сущностей

export interface B24User {
  ID: string;
  ACTIVE: boolean;
  NAME: string;
  LAST_NAME: string;
  SECOND_NAME?: string;
  EMAIL: string;
  PERSONAL_PHONE?: string;
  WORK_POSITION?: string;
}

export interface B24Deal {
  ID: string;
  TITLE: string;
  STAGE_ID: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  ASSIGNED_BY_ID: string;
  DATE_CREATE: string;
  COMMENTS?: string;
}

export interface B24Contact {
  ID: string;
  NAME: string;
  LAST_NAME: string;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  ASSIGNED_BY_ID: string;
}

export interface B24Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  creator: { id: string; name: string };
  responsible: { id: string; name: string };
  deadline?: string;
  createdDate: string;
  sprintId?: string;
}

export const bitrix24 = {
  // Информация о текущем пользователе
  getCurrentUser: async (token: string): Promise<B24User> => {
    return callBitrix24<B24User>("user.current", {}, token);
  },

  searchUsers: async (token: string, name?: string, email?: string): Promise<B24User[]> => {
    const filter: any = {};
    if (name) {
      filter["NAME_SEARCH"] = name; // NAME_SEARCH is often supported, or we can use "FIND"
    }
    if (email) {
      filter["EMAIL"] = email;
    }
    return callBitrix24<B24User[]>("user.get", {
      FILTER: filter,
      ADMIN_MODE: true // requires 'user' scope and admin rights for full list
    }, token);
  },

  // Сделки (Deals)
  listDeals: async (token: string, filter?: any, select?: string[]): Promise<B24Deal[]> => {
    let start = 0;
    let allDeals: B24Deal[] = [];
    const maxLimit = 1000;
    
    while (true) {
      const res = await callBitrix24<B24Deal[]>(
        "crm.deal.list",
        {
          filter: cleanFields(filter),
          select: select || ["ID", "TITLE", "STAGE_ID", "OPPORTUNITY", "CURRENCY_ID", "ASSIGNED_BY_ID", "DATE_CREATE"],
          start: start
        },
        token
      );
      
      if (!res || !Array.isArray(res) || res.length === 0) {
        break;
      }
      
      allDeals = allDeals.concat(res);
      
      if (res.length < 50 || allDeals.length >= maxLimit) {
        break;
      }
      
      start += 50;
    }
    
    const meta = await getFieldsMetadataCached(token, "deal");
    return mapObjectFields(allDeals, meta);
  },

  getDeal: async (token: string, id: string): Promise<B24Deal> => {
    const deal = await callBitrix24<B24Deal>("crm.deal.get", { id }, token);
    const meta = await getFieldsMetadataCached(token, "deal");
    return mapObjectFields(deal, meta);
  },

  createDeal: async (token: string, fields: Partial<B24Deal>): Promise<string> => {
    return callBitrix24<string>("crm.deal.add", { fields: cleanFields(fields) }, token);
  },

  updateDeal: async (token: string, id: string, fields: Partial<B24Deal>): Promise<boolean> => {
    return callBitrix24<boolean>("crm.deal.update", { id, fields: cleanFields(fields) }, token);
  },

  // Контакты (Contacts)
  listContacts: async (token: string, filter?: any, select?: string[]): Promise<B24Contact[]> => {
    let start = 0;
    let allContacts: B24Contact[] = [];
    const maxLimit = 1000;
    
    while (true) {
      const res = await callBitrix24<B24Contact[]>(
        "crm.contact.list",
        {
          filter: cleanFields(filter),
          select: select || ["ID", "NAME", "LAST_NAME", "PHONE", "EMAIL", "ASSIGNED_BY_ID"],
          start: start
        },
        token
      );
      
      if (!res || !Array.isArray(res) || res.length === 0) {
        break;
      }
      
      allContacts = allContacts.concat(res);
      
      if (res.length < 50 || allContacts.length >= maxLimit) {
        break;
      }
      
      start += 50;
    }
    
    const meta = await getFieldsMetadataCached(token, "contact");
    return mapObjectFields(allContacts, meta);
  },

  createContact: async (token: string, fields: Partial<B24Contact>): Promise<string> => {
    return callBitrix24<string>("crm.contact.add", { fields: cleanFields(fields) }, token);
  },

  // Задачи (Tasks)
  listTasks: async (token: string, filter?: any, select?: string[]): Promise<B24Task[]> => {
    let start = 0;
    let allTasks: B24Task[] = [];
    const maxLimit = 1000;
    
    while (true) {
      const res = await callBitrix24<{ tasks: B24Task[] }>(
        "tasks.task.list",
        {
          filter,
          select: select || ["id", "title", "status", "deadline", "responsibleId", "createdDate", "SPRINT_ID"],
          start: start
        },
        token
      );
      
      const pageTasks = res.tasks || [];
      if (pageTasks.length === 0) {
        break;
      }
      
      allTasks = allTasks.concat(pageTasks);
      
      if (pageTasks.length < 50 || allTasks.length >= maxLimit) {
        break;
      }
      
      start += 50;
    }
    
    return allTasks;
  },

  getTask: async (token: string, id: string): Promise<{ task: B24Task }> => {
    return callBitrix24<{ task: B24Task }>("tasks.task.get", { taskId: id }, token);
  },

  createTask: async (token: string, fields: any): Promise<{ task: B24Task }> => {
    return callBitrix24<{ task: B24Task }>("tasks.task.add", { fields }, token);
  },

  updateTask: async (token: string, id: string, fields: any): Promise<{ task: B24Task }> => {
    return callBitrix24<{ task: B24Task }>("tasks.task.update", { taskId: id, fields }, token);
  },

  // Группы и проекты (Скрам-доски)
  listWorkgroups: async (token: string, filter?: any): Promise<B24Workgroup[]> => {
    try {
      console.log("[Bitrix24] Fetching all workgroups with pagination for Scrum filtering...");
      let start = 0;
      let allGroups: any[] = [];
      
      while (true) {
        console.log(`[Bitrix24] Fetching page start = ${start}...`);
        const res = await callBitrix24<any>(
          "socialnetwork.api.workgroup.list",
          {
            filter: filter || {},
            select: ["id", "name", "description", "project", "closed", "type"],
            start: start
          },
          token
        );
        
        let pageGroups: any[] = [];
        if (res && Array.isArray(res)) {
          pageGroups = res;
        } else if (res && res.workgroups && Array.isArray(res.workgroups)) {
          pageGroups = res.workgroups;
        } else if (res && res.groups && Array.isArray(res.groups)) {
          pageGroups = res.groups;
        }
        
        if (pageGroups.length === 0) {
          break;
        }
        
        allGroups = allGroups.concat(pageGroups);
        
        if (pageGroups.length < 50) {
          break;
        }
        start += 50;
      }
      
      console.log(`[Bitrix24] Total workgroups fetched: ${allGroups.length}. Filtering for type === 'scrum'...`);
      
      // Фильтруем группы: оставляем ТОЛЬКО скрам-доски (type === 'scrum')
      const scrumGroups = allGroups.filter((g: any) => {
        const type = String(g.type || g.TYPE || "").toLowerCase();
        return type === "scrum";
      });
      
      console.log(`[Bitrix24] Found ${scrumGroups.length} Scrum boards.`);
      
      return scrumGroups.map((g: any) => ({
        ID: String(g.id || g.ID || ""),
        NAME: String(g.name || g.NAME || ""),
        DESCRIPTION: String(g.description || g.DESCRIPTION || ""),
        PROJECT: String(g.project || g.PROJECT || "N"),
        CLOSED: String(g.closed || g.CLOSED || "N"),
        TYPE: String(g.type || g.TYPE || "")
      }));
    } catch (err: any) {
      console.warn("[Bitrix24] socialnetwork.api.workgroup.list failed, falling back to sonet_group.get:", err.message);
    }

    console.log("[Bitrix24] Falling back to sonet_group.get (sonet scope)...");
    const sonetFilter: any = {};
    if (filter) {
      for (const key of Object.keys(filter)) {
        sonetFilter[key.toUpperCase()] = filter[key];
      }
    }
    // Принудительно задаем TYPE в фильтре для фоллбека
    sonetFilter["TYPE"] = "scrum";
    
    const res = await callBitrix24<B24Workgroup[]>(
      "sonet_group.get",
      {
        FILTER: sonetFilter,
        ORDER: { NAME: "ASC" }
      },
      token
    );
    
    // Дополнительно фильтруем на клиенте для надежности фоллбека
    return res.filter((g: any) => {
      const type = String(g.type || g.TYPE || "").toLowerCase();
      return type === "scrum";
    });
  },

  // Спринты (Sprints)
  listScrumSprints: async (token: string, groupId: string): Promise<any[]> => {
    return callBitrix24<any[]>(
      "tasks.api.scrum.sprint.list",
      {
        filter: {
          GROUP_ID: Number(groupId)
        },
        order: {
          id: "DESC"
        }
      },
      token
    );
  },

  // Комментарии к задаче
  listTaskComments: async (token: string, taskId: string): Promise<any[]> => {
    try {
      // 1. Сначала пробуем получить стандартные комментарии
      const legacyComments = await callBitrix24<any[]>(
        "task.commentitem.getlist",
        {
          TASKID: Number(taskId),
          ORDER: { ID: "ASC" },
          FILTER: {}
        },
        token
      );
      
      if (Array.isArray(legacyComments) && legacyComments.length > 0) {
        return legacyComments;
      }
      
      // 2. Если пустой список, пробуем получить чат задачи через IM API
      console.log(`[Bitrix24] Legacy comments empty for task ${taskId}. Trying IM chat comments...`);
      try {
        const chatRes = await callBitrix24<any>(
          "im.chat.get",
          {
            ENTITY_TYPE: "TASKS_TASK",
            ENTITY_ID: Number(taskId)
          },
          token
        );
        
        const chatId = chatRes?.id || chatRes?.ID;
        if (chatId) {
          console.log(`[Bitrix24] Found task chatId ${chatId} for task ${taskId}. Fetching messages...`);
          const messagesRes = await callBitrix24<any>(
            "im.dialog.messages.get",
            {
              DIALOG_ID: `chat${chatId}`,
              LIMIT: 50
            },
            token
          );
          
          const messages = messagesRes?.messages || [];
          const users = messagesRes?.users || {};
          
          if (Array.isArray(messages) && messages.length > 0) {
            // Маппим сообщения чата под формат ctaskcommentitem::getlist
            // Сортируем сообщения по возрастанию даты (самые старые вверху, новые внизу)
            const mapped = messages
              .map((m: any) => {
                const user = users[m.author_id || m.AUTHOR_ID] || {};
                return {
                  ID: String(m.id || m.ID),
                  AUTHOR_NAME: user.name || user.NAME || `Пользователь ID ${m.author_id || m.AUTHOR_ID}`,
                  POST_DATE: m.date || m.DATE,
                  POST_MESSAGE: m.text || m.TEXT,
                  POST_MESSAGE_HTML: m.text || m.TEXT
                };
              })
              .reverse(); // im.dialog.messages.get возвращает сообщения в обратном хронологическом порядке (сначала новые)
            
            return mapped;
          }
        }
      } catch (imErr: any) {
        console.warn(`[Bitrix24] IM chat comments retrieval failed for task ${taskId} (likely due to missing 'im' scope or no chat):`, imErr.message || imErr);
      }
      
      return [];
    } catch (err) {
      console.warn(`[Bitrix24] listTaskComments failed for task ${taskId}:`, err);
      return [];
    }
  },

  // Добавление комментария к задаче (с поддержкой файлов)
  addTaskComment: async (token: string, taskId: string, text: string, files?: Array<{ name: string, contentBase64: string }>): Promise<string> => {
    const attachmentIds: string[] = [];
    
    if (files && files.length > 0) {
      for (const file of files) {
        try {
          const fileRes = await callBitrix24<any>("task.item.addfile", {
            TASKID: Number(taskId),
            FILE: {
              NAME: file.name,
              CONTENT: file.contentBase64
            }
          }, token);
          
          if (fileRes && fileRes.ATTACHMENT_ID) {
            attachmentIds.push("n" + fileRes.ATTACHMENT_ID);
          }
        } catch (err: any) {
          console.warn(`[Bitrix24] Failed to upload file ${file.name} to task ${taskId}:`, err.message);
        }
      }
    }
    
    const fields: any = {
      POST_MESSAGE: text
    };
    
    if (attachmentIds.length > 0) {
      fields.UF_FORUM_MESSAGE_DOC = attachmentIds;
    }
    
    return callBitrix24<string>("task.commentitem.add", {
      TASKID: Number(taskId),
      FIELDS: fields
    }, token);
  },
  
  // База знаний 2.0 (Knowledge Base REST 3.0)
  listKnowledgeBases: async (token: string): Promise<any[]> => {
    return callBitrix24<any>("note.collection.list", {}, token)
      .then(res => res && res.items ? res.items : []);
  },

  listKnowledgeBasePages: async (token: string, kbId: string): Promise<any[]> => {
    return callBitrix24<any>("note.document.tree.list", { collectionId: Number(kbId) }, token)
      .then(res => res && res.items ? res.items : []);
  },

  getKnowledgeBasePage: async (token: string, pageId: string): Promise<any> => {
    return callBitrix24<any>("note.document.get", { id: Number(pageId) }, token)
      .then(res => res && res.item ? res.item : null);
  },

  addKnowledgeBasePage: async (token: string, kbId: string, title: string, markdown: string, parentId?: string): Promise<any> => {
    const fields: any = {
      collectionId: Number(kbId),
      title: title,
      markdown: markdown
    };
    if (parentId) {
      fields.parentId = Number(parentId);
    }
    
    return callBitrix24<any>("note.document.add", { fields }, token)
      .then(res => res && res.item ? res.item : res);
  },

  updateKnowledgeBasePage: async (token: string, pageId: string, title?: string, markdown?: string): Promise<any> => {
    const fields: any = {};
    if (title !== undefined) fields.title = title;
    if (markdown !== undefined) fields.markdown = markdown;
    
    return callBitrix24<any>("note.document.update", { 
      id: Number(pageId), 
      fields 
    }, token)
      .then(res => res && res.item ? res.item : res);
  },
};

export interface B24Workgroup {
  ID: string;
  NAME: string;
  DESCRIPTION?: string;
  PROJECT?: string; // 'Y' - проект, 'N' - рабочая группа
  CLOSED?: string;  // 'Y' - закрытая, 'N' - открытая
  TYPE?: string;    // 'scrum' - скрам-доска, etc.
}
