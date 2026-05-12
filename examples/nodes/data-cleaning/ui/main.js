const parts = window.location.pathname.split("/");
const runId = parts[3];
const nodeId = parts[5];

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function load() {
  const result = await api(`/api/runs/${runId}/nodes/${nodeId}/result`);
  document.querySelector("#summary").textContent = result.summary || "暂无结果摘要";
  const data = await api(`/api/runs/${runId}/nodes/${nodeId}/query`, {
    method: "POST",
    body: JSON.stringify({ dataset: "customers", page: 1, pageSize: 100 }),
  });
  document.querySelector("#rows").innerHTML = data.rows
    .map(
      (row) => `
        <tr>
          <td>${row.id}</td>
          <td>${row.name}</td>
          <td><input data-id="${row.id}" data-field="phone" value="${row.phone}" /></td>
          <td><input data-id="${row.id}" data-field="issue" value="${row.issue}" /></td>
          <td>${row.status}</td>
          <td><button data-save="${row.id}">保存</button></td>
        </tr>
      `
    )
    .join("");
}

document.addEventListener("click", async (event) => {
  const saveId = event.target.dataset?.save;
  if (saveId) {
    const phone = document.querySelector(`input[data-id="${saveId}"][data-field="phone"]`).value;
    const issue = document.querySelector(`input[data-id="${saveId}"][data-field="issue"]`).value;
    await api(`/api/runs/${runId}/nodes/${nodeId}/records/customers/${saveId}`, {
      method: "PATCH",
      body: JSON.stringify({ phone, issue, status: issue === "ok" ? "clean" : "needs-review" }),
    });
    await load();
  }
});

document.querySelector("#confirm").addEventListener("click", async () => {
  await api(`/api/runs/${runId}/nodes/${nodeId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "节点 UI 确认继续" }),
  });
  window.alert("已确认，后续节点开始执行。");
});

load().catch((error) => {
  document.querySelector("#summary").textContent = error.message;
});
