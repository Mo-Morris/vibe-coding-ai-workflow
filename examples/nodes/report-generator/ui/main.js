const parts = window.location.pathname.split("/");
const runId = parts[3];
const nodeId = parts[5];

fetch(`/api/runs/${runId}/nodes/${nodeId}/result`)
  .then((response) => response.json())
  .then((result) => {
    document.querySelector("#summary").textContent = result.summary || "暂无结果摘要";
  })
  .catch((error) => {
    document.querySelector("#summary").textContent = error.message;
  });
