name: test
label: 测试
description: 测试
mode: manual-confirm
nodes:
- id: csv-table-editor
  node: csv-table-editor
  depends_on: []
- id: url-pet-labeler
  node: url-pet-labeler
  depends_on:
  - csv-table-editor
