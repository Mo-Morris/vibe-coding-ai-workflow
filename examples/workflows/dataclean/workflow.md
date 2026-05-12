name: dataclean
label: 数据清洗
description: ''
mode: manual-confirm
nodes:
- id: csv-table-editor
  node: csv-table-editor
  depends_on: []
- id: url-items-source
  node: url-items-source
  depends_on:
  - csv-table-editor
- id: url-pet-labeler
  node: url-pet-labeler
  depends_on:
  - url-items-source
- id: report-generator
  node: report-generator
  depends_on:
  - url-pet-labeler
