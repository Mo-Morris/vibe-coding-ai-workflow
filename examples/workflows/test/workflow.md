name: test
label: 测试工作流
description: 测试工作流
mode: manual-confirm
nodes:
- id: data-cleaning
  node: data-cleaning
  depends_on: []
- id: report-generator
  node: report-generator
  depends_on:
  - data-cleaning
