const parts = window.location.pathname.split("/");
const runId = parts[3];
const nodeId = parts[5];

const DATASET = "csv";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function uploadApi(path, formData) {
  const response = await fetch(path, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

let lastColumns = [];
let searchQuery = "";

async function loadTable() {
  const endpoint = searchQuery
    ? `/api/runs/${runId}/nodes/${nodeId}/search`
    : `/api/runs/${runId}/nodes/${nodeId}/query`;
  const body = searchQuery
    ? JSON.stringify({ dataset: DATASET, q: searchQuery, page: 1, pageSize: 500 })
    : JSON.stringify({ dataset: DATASET, page: 1, pageSize: 500 });
  const data = await api(endpoint, { method: "POST", body });
  if (!data.ok) throw new Error(data.error?.message || "加载失败");
  lastColumns = data.columns || [];
  renderHead(lastColumns);
  renderRows(lastColumns, data.rows || []);
}

function renderHead(columns) {
  const thead = document.querySelector("#thead");
  thead.innerHTML = `<tr>${columns
    .map((c) => `<th>${escapeHtml(c.label ?? c.key)}</th>`)
    .join("")}<th>操作</th></tr>`;
}

function renderRows(columns, rows) {
  const tbody = document.querySelector("#rows");
  const keys = columns.map((c) => c.key);
  tbody.innerHTML = rows
    .map((row) => {
      const id = escapeHtml(row.id);
      const cells = keys
        .map((key) => {
          if (key === "id") {
            return `<td>${escapeHtml(row[key])}</td>`;
          }
          const v = row[key] == null ? "" : String(row[key]);
          return `<td><input type="text" data-id="${id}" data-field="${escapeHtml(key)}" value="${escapeHtml(v)}" /></td>`;
        })
        .join("");
      return `<tr>${cells}<td><button type="button" data-save="${id}">保存本行</button></td></tr>`;
    })
    .join("");
}

async function load() {
  const result = await api(`/api/runs/${runId}/nodes/${nodeId}/result`);
  document.querySelector("#summary").textContent = result.summary || "暂无结果摘要";
  await loadTable();
}

document.addEventListener("click", async (event) => {
  const saveId = event.target.dataset?.save;
  if (!saveId) return;
  const patch = {};
  document.querySelectorAll(`input[data-id="${CSS.escape(saveId)}"][data-field]`).forEach((el) => {
    const field = el.dataset.field;
    if (field && field !== "id") patch[field] = el.value;
  });
  await api(`/api/runs/${runId}/nodes/${nodeId}/records/${DATASET}/${saveId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await loadTable();
});

document.querySelector("#searchBtn").addEventListener("click", async () => {
  searchQuery = document.querySelector("#search").value.trim();
  try {
    await loadTable();
  } catch (error) {
    document.querySelector("#summary").textContent = error.message;
  }
});

document.querySelector("#resetBtn").addEventListener("click", async () => {
  document.querySelector("#search").value = "";
  searchQuery = "";
  try {
    await loadTable();
  } catch (error) {
    document.querySelector("#summary").textContent = error.message;
  }
});

document.querySelector("#csvFile").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  const fileName = file?.name || "未选择文件";
  document.querySelector("#fileName").textContent = fileName;
  document.querySelector("#uploadBtn").hidden = !file;
  document.querySelector("#uploadStatus").textContent = "";
});

document.querySelector("#uploadBtn").addEventListener("click", async () => {
  const input = document.querySelector("#csvFile");
  const status = document.querySelector("#uploadStatus");
  const file = input.files?.[0];
  if (!file) {
    status.textContent = "请选择 CSV 文件";
    return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("field", "csv");
  status.textContent = "上传中…";
  try {
    const result = await uploadApi(`/api/runs/${runId}/nodes/${nodeId}/upload`, formData);
    status.textContent = result.summary || result.node?.summary || "上传完成";
    input.value = "";
    document.querySelector("#fileName").textContent = "未选择文件";
    document.querySelector("#uploadBtn").hidden = true;
    searchQuery = "";
    document.querySelector("#search").value = "";
    await load();
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#confirm").addEventListener("click", async () => {
  await api(`/api/runs/${runId}/nodes/${nodeId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "CSV 表格已确认" }),
  });
  window.alert("已确认，后续节点开始执行。");
});

load().catch((error) => {
  document.querySelector("#summary").textContent = error.message;
});
