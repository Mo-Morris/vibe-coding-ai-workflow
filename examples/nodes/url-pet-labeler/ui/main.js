const parts = window.location.pathname.split("/");
const runId = parts[3];
const nodeId = parts[5];

const DATASET = "urls";

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

let searchQuery = "";

function isLikelyImageUrl(u) {
  try {
    const pathname = new URL(u).pathname;
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(pathname);
  } catch {
    return false;
  }
}

function previewHtml(url) {
  const safe = escapeHtml(url);
  if (isLikelyImageUrl(url)) {
    return `<img src="${safe}" alt="" loading="lazy" />`;
  }
  return `<iframe title="预览" src="${safe}" loading="lazy"></iframe>`;
}

async function loadRows() {
  const endpoint = searchQuery
    ? `/api/runs/${runId}/nodes/${nodeId}/search`
    : `/api/runs/${runId}/nodes/${nodeId}/query`;
  const body = searchQuery
    ? JSON.stringify({ dataset: DATASET, q: searchQuery, page: 1, pageSize: 200 })
    : JSON.stringify({ dataset: DATASET, page: 1, pageSize: 200 });
  const data = await api(endpoint, { method: "POST", body });
  if (!data.ok) throw new Error(data.error?.message || "加载失败");
  return data.rows || [];
}

function render(rows) {
  const root = document.querySelector("#cards");
  root.innerHTML = rows
    .map((row) => {
      const id = escapeHtml(row.id);
      const url = row.url == null ? "" : String(row.url);
      const label = row.label == null ? "" : String(row.label);
      const labelText = label ? escapeHtml(label) : "未标注";
      return `
      <article class="card" data-row-id="${id}">
        <div class="card-head">
          <span>ID ${id}</span>
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
        </div>
        <div class="preview">${previewHtml(url)}</div>
        <div class="card-actions">
          <span class="badge">当前：<strong>${labelText}</strong></span>
          <button type="button" class="primary-cat" data-label-cat="${id}">标为 小猫</button>
          <button type="button" class="primary-dog" data-label-dog="${id}">标为 小狗</button>
        </div>
      </article>`;
    })
    .join("");
}

async function load() {
  const result = await api(`/api/runs/${runId}/nodes/${nodeId}/result`);
  document.querySelector("#summary").textContent = result.summary || "暂无摘要";
  const rows = await loadRows();
  render(rows);
}

document.addEventListener("click", async (event) => {
  const catId = event.target.dataset?.labelCat;
  const dogId = event.target.dataset?.labelDog;
  const id = catId || dogId;
  if (!id) return;
  const label = catId ? "小猫" : "小狗";
  await api(`/api/runs/${runId}/nodes/${nodeId}/records/${DATASET}/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });
  await load();
});

document.querySelector("#searchBtn").addEventListener("click", async () => {
  searchQuery = document.querySelector("#search").value.trim();
  try {
    await load();
  } catch (error) {
    document.querySelector("#summary").textContent = error.message;
  }
});

document.querySelector("#resetBtn").addEventListener("click", async () => {
  document.querySelector("#search").value = "";
  searchQuery = "";
  try {
    await load();
  } catch (error) {
    document.querySelector("#summary").textContent = error.message;
  }
});

document.querySelector("#confirm").addEventListener("click", async () => {
  await api(`/api/runs/${runId}/nodes/${nodeId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "URL 猫狗标注已确认" }),
  });
  window.alert("已确认，后续节点开始执行。");
});

load().catch((error) => {
  document.querySelector("#summary").textContent = error.message;
});
